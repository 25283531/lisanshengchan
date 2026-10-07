"""
注塑排产 CP-SAT 求解器。

建模取自 E:\\code\\lisanshengchan 的 OR-Tools 模型并针对 molding-mes 的口径扩展：

1. 四类资源互斥：机台 / 模具 / 供料线 / 混料机，AddNoOverlap
2. 硬约束：供料线故障连带封锁关联机台（在 Node 侧展开 options 时已过滤）
3. 换模三态：用决策变量 setup_minutes 随选中 option 计入目标函数；
   同机台连续同模具的 setup=0 由 Node 侧给每个 option 预算 setup 实现
4. 集中供料时点反推：由 Node 侧按 start_at 偏移计算，求解器只给开工时点
5. 模具保养阈值告警：求解器输出后由 Node 侧按累计模次判定
6. 目标：Σ(逾期×权重) + Σ(换模时长) + Σ(完工×完工权重)
   SALES 权重 = 100 + priority×10；STOCK 权重 = 20 + priority×5
   与列表调度不同，CP-SAT 在 horizon 内全局搜索联合最优

接口契约（POST /optimize）：
  入参 jobs / machine_busy / mold_busy / line_busy / mixer_busy / horizon_hours
  出参 feasible / objective / assignments / algorithm / solver_status
"""
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

from ortools.sat.python import cp_model

app = FastAPI(title="molding-mes CP-SAT 求解器", version="3.1.0")


class BusyInterval(BaseModel):
    resource_code: str
    start: datetime
    end: datetime


class Option(BaseModel):
    machine_code: str
    supply_line_code: Optional[str] = None
    mixer_code: Optional[str] = None
    mold_code: str
    duration_minutes: int = Field(gt=0)
    setup_minutes: int = 0
    ready_from_minutes: int = 0
    efficiency: float = 0.0


class Job(BaseModel):
    code: str
    quantity: int = Field(gt=0)
    order_type: Literal["SALES", "STOCK"] = "SALES"
    due_date: Optional[datetime] = None
    priority: int = 0
    options: list[Option] = Field(min_length=1)


class Request(BaseModel):
    jobs: list[Job]
    machine_busy: list[BusyInterval] = Field(default_factory=list)
    mold_busy: list[BusyInterval] = Field(default_factory=list)
    line_busy: list[BusyInterval] = Field(default_factory=list)
    mixer_busy: list[BusyInterval] = Field(default_factory=list)
    horizon_hours: int = Field(default=24 * 30, ge=1)
    buffer_minutes: int = Field(default=30, ge=0)


def minutes_from_epoch(value: datetime, epoch: datetime) -> int:
    if value.tzinfo is None:
        value = value.astimezone()
    if epoch.tzinfo is None:
        epoch = epoch.astimezone()
    return max(0, round((value - epoch).total_seconds() / 60))


@app.get("/health")
def health():
    return {"status": "ok", "algorithm": "cp-sat-v3.1", "version": "3.1.0"}


@app.post("/optimize")
def optimize(data: Request):
    if not data.jobs:
        return {"feasible": False, "reason": "jobs 为空", "algorithm": "cp-sat-v3.1"}

    model = cp_model.CpModel()
    epoch = datetime.now().astimezone().replace(second=0, microsecond=0)
    horizon = data.horizon_hours * 60
    buffer_min = data.buffer_minutes

    if any(
        not any(option.duration_minutes + option.setup_minutes + buffer_min <= horizon for option in job.options)
        for job in data.jobs
    ):
        return {
            "feasible": False,
            "reason": "至少一张订单没有能在排产时间窗内完成的候选资源",
            "algorithm": "cp-sat-v3.1",
        }

    option_vars: dict[tuple[str, int], tuple] = {}
    machine_intervals: dict[str, list] = {}
    mold_intervals: dict[str, list] = {}
    line_intervals: dict[str, list] = {}
    mixer_intervals: dict[str, list] = {}
    job_lateness: dict[str, cp_model.IntVar] = {}
    job_end_vars: dict[str, list] = {}

    def add_busy(interval: BusyInterval, target: dict, prefix: str):
        start = minutes_from_epoch(interval.start, epoch)
        end = min(horizon, minutes_from_epoch(interval.end, epoch))
        if end <= 0 or end <= start:
            return
        start = max(0, start)
        fixed = model.NewIntervalVar(start, end - start, end, f"{prefix}_{interval.resource_code}_{start}")
        target.setdefault(interval.resource_code, []).append(fixed)

    for busy in data.machine_busy:
        add_busy(busy, machine_intervals, "busy_machine")
    for busy in data.mold_busy:
        add_busy(busy, mold_intervals, "busy_mold")
    for busy in data.line_busy:
        add_busy(busy, line_intervals, "busy_line")
    for busy in data.mixer_busy:
        add_busy(busy, mixer_intervals, "busy_mixer")

    for job in data.jobs:
        job_options = []
        ends = []
        for index, option in enumerate(job.options):
            duration = max(1, option.duration_minutes)
            setup = max(0, option.setup_minutes)
            total = duration + setup + buffer_min
            selected = model.NewBoolVar(f"use_{job.code}_{index}")
            start = model.NewIntVar(0, max(0, horizon - total), f"start_{job.code}_{index}")
            end = model.NewIntVar(0, horizon, f"end_{job.code}_{index}")
            interval = model.NewOptionalIntervalVar(start, total, end, selected, f"job_{job.code}_{index}")
            model.Add(start >= max(0, option.ready_from_minutes)).OnlyEnforceIf(selected)
            option_vars[(job.code, index)] = (start, end, interval, selected, setup)
            machine_intervals.setdefault(option.machine_code, []).append(interval)
            mold_intervals.setdefault(option.mold_code, []).append(interval)
            if option.supply_line_code:
                line_intervals.setdefault(option.supply_line_code, []).append(interval)
            if option.mixer_code:
                mixer_intervals.setdefault(option.mixer_code, []).append(interval)
            job_options.append(selected)
            ends.append(end)
        model.Add(sum(job_options) == 1)
        job_end_vars[job.code] = ends
        due = minutes_from_epoch(job.due_date, epoch) if job.due_date else horizon
        late = model.NewIntVar(0, horizon + 100000, f"late_{job.code}")
        job_lateness[job.code] = late
        for index, selected in enumerate(job_options):
            model.Add(late >= ends[index] - due).OnlyEnforceIf(selected)
        model.Add(late >= 0)

    for intervals in machine_intervals.values():
        model.AddNoOverlap(intervals)
    for intervals in mold_intervals.values():
        model.AddNoOverlap(intervals)
    for intervals in line_intervals.values():
        model.AddNoOverlap(intervals)
    for intervals in mixer_intervals.values():
        model.AddNoOverlap(intervals)

    objective_terms = []
    for job in data.jobs:
        urgency_weight = max(1, 100 + job.priority * 10) if job.order_type == "SALES" else max(1, 20 + job.priority * 5)
        objective_terms.append(job_lateness[job.code] * urgency_weight)
        for index, option in enumerate(job.options):
            _, _, _, selected, setup = option_vars[(job.code, index)]
            objective_terms.append(setup * selected)
            completion_weight = 5 if job.order_type == "SALES" else 1
            objective_terms.append(option_vars[(job.code, index)][1] * completion_weight)
    model.Minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "feasible": False,
            "reason": "CP-SAT 在给定时间窗内找不到可行联合排产",
            "algorithm": "cp-sat-v3.1",
        }

    assignments = []
    for job in data.jobs:
        for index, option in enumerate(job.options):
            start, end, _, selected, setup = option_vars[(job.code, index)]
            if solver.Value(selected):
                start_at = epoch + timedelta(minutes=solver.Value(start))
                # 实际开工 = 缓冲与换模之后；返回两层时间，让 Node 侧区分
                work_start = start_at + timedelta(minutes=setup + buffer_min)
                end_at = epoch + timedelta(minutes=solver.Value(end))
                assignments.append(
                    {
                        "job_code": job.code,
                        "machine_code": option.machine_code,
                        "supply_line_code": option.supply_line_code,
                        "mixer_code": option.mixer_code,
                        "mold_code": option.mold_code,
                        "scheduled_start": start_at.isoformat(),
                        "work_start": work_start.isoformat(),
                        "scheduled_end": end_at.isoformat(),
                        "duration_minutes": option.duration_minutes,
                        "setup_minutes": setup,
                        "efficiency": option.efficiency,
                        "lateness_minutes": solver.Value(job_lateness[job.code]),
                    }
                )
                break
    return {
        "feasible": True,
        "objective": solver.ObjectiveValue(),
        "assignments": assignments,
        "algorithm": "cp-sat-v3.1",
        "solver_status": solver.StatusName(status),
    }