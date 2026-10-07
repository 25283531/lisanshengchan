from datetime import datetime, timedelta
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field
from ortools.sat.python import cp_model

app = FastAPI(title="智注排产 OR-Tools 联合优化服务")


class BusyInterval(BaseModel):
    resource_code: str
    start: datetime
    end: datetime


class Option(BaseModel):
    machine_code: str
    supply_line_code: str
    mixer_code: str | None = None
    mold_code: str
    duration_minutes: int = Field(gt=0)
    setup_minutes: int = 0
    ready_from_minutes: int = 0


class Job(BaseModel):
    code: str
    quantity: int = Field(gt=0)
    order_type: Literal["SALES", "STOCK"] = "SALES"
    due_date: datetime | None = None
    priority: int = 0
    options: list[Option] = Field(min_length=1)


class Request(BaseModel):
    jobs: list[Job]
    machine_busy: list[BusyInterval] = Field(default_factory=list)
    mold_busy: list[BusyInterval] = Field(default_factory=list)
    line_busy: list[BusyInterval] = Field(default_factory=list)
    mixer_busy: list[BusyInterval] = Field(default_factory=list)
    horizon_hours: int = Field(default=24 * 30, ge=1)


def minutes_from_epoch(value: datetime, epoch: datetime) -> int:
    if value.tzinfo is None:
        value = value.astimezone()
    if epoch.tzinfo is None:
        epoch = epoch.astimezone()
    return max(0, round((value - epoch).total_seconds() / 60))


@app.get("/health")
def health():
    return {"status": "ok", "algorithm": "cp-sat-v3"}


@app.post("/optimize")
def optimize(data: Request):
    if not data.jobs:
        return {"feasible": False, "reason": "jobs are required", "algorithm": "cp-sat-v3"}

    model = cp_model.CpModel()
    epoch = datetime.now().astimezone().replace(second=0, microsecond=0)
    horizon = data.horizon_hours * 60
    if any(not any(option.duration_minutes <= horizon for option in job.options) for job in data.jobs):
        return {"feasible": False, "reason": "至少一张订单没有能在排产时间窗内完成的候选资源", "algorithm": "cp-sat-v3"}
    option_vars: dict[tuple[str, int], tuple[cp_model.IntVar, cp_model.IntVar, cp_model.IntervalVar, cp_model.BoolVar]] = {}
    machine_intervals: dict[str, list[cp_model.IntervalVar]] = {}
    mold_intervals: dict[str, list[cp_model.IntervalVar]] = {}
    line_intervals: dict[str, list[cp_model.IntervalVar]] = {}
    mixer_intervals: dict[str, list[cp_model.IntervalVar]] = {}
    job_lateness: dict[str, cp_model.IntVar] = {}
    job_end_vars: dict[str, list[cp_model.IntVar]] = {}

    def add_busy(interval: BusyInterval, target: dict[str, list[cp_model.IntervalVar]], prefix: str):
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
            selected = model.NewBoolVar(f"use_{job.code}_{index}")
            start = model.NewIntVar(0, max(0, horizon - duration), f"start_{job.code}_{index}")
            end = model.NewIntVar(0, horizon, f"end_{job.code}_{index}")
            interval = model.NewOptionalIntervalVar(start, duration, end, selected, f"job_{job.code}_{index}")
            model.Add(start >= max(0, option.ready_from_minutes)).OnlyEnforceIf(selected)
            option_vars[(job.code, index)] = (start, end, interval, selected)
            machine_intervals.setdefault(option.machine_code, []).append(interval)
            mold_intervals.setdefault(option.mold_code, []).append(interval)
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
            objective_terms.append(option.setup_minutes * option_vars[(job.code, index)][3])
            # Tie-break toward earlier completion; retain integer-linear CP-SAT terms.
            completion_weight = 5 if job.order_type == "SALES" else 1
            objective_terms.append(option_vars[(job.code, index)][1] * completion_weight)
    model.Minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"feasible": False, "reason": "CP-SAT 在给定时间窗内找不到可行联合排产", "algorithm": "cp-sat-v3"}

    assignments = []
    for job in data.jobs:
        for index, option in enumerate(job.options):
            start, end, _, selected = option_vars[(job.code, index)]
            if solver.Value(selected):
                start_at = epoch + timedelta(minutes=solver.Value(start))
                end_at = epoch + timedelta(minutes=solver.Value(end))
                assignments.append({
                    "job_code": job.code,
                    "machine_code": option.machine_code,
                    "supply_line_code": option.supply_line_code,
                    "mixer_code": option.mixer_code,
                    "mold_code": option.mold_code,
                    "scheduled_start": start_at,
                    "scheduled_end": end_at,
                    "duration_minutes": option.duration_minutes,
                    "setup_minutes": option.setup_minutes,
                    "lateness_minutes": solver.Value(job_lateness[job.code]),
                })
                break
    return {
        "feasible": True,
        "objective": solver.ObjectiveValue(),
        "assignments": assignments,
        "algorithm": "cp-sat-v3",
        "solver_status": solver.StatusName(status),
    }
