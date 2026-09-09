from datetime import datetime, timedelta
from fastapi import FastAPI
from pydantic import BaseModel, Field
from ortools.sat.python import cp_model
app = FastAPI(title="智注排产优化服务")
class Job(BaseModel):
    code: str
    quantity: int = Field(gt=0)
    due_date: datetime | None = None
    priority: int = 0

class Machine(BaseModel):
    code: str
    units_per_hour: float = Field(gt=0)
    setup_minutes: int = 0
    available_from: datetime | None = None

class Request(BaseModel):
    jobs: list[Job]
    machines: list[Machine]
    horizon_hours: int = 24 * 30
@app.get('/health')
def health(): return {'status': 'ok'}
@app.post('/optimize')
def optimize(data: Request):
    if not data.jobs or not data.machines:
        return {'feasible': False, 'reason': 'jobs and machines are required', 'algorithm': 'cp-sat-v1'}
    model = cp_model.CpModel()
    epoch = datetime.now().replace(second=0, microsecond=0)
    horizon = data.horizon_hours * 60
    starts, ends, intervals, assignments, lateness = {}, {}, {}, {}, {}
    for job in data.jobs:
        for machine in data.machines:
            key = (job.code, machine.code)
            duration = max(1, round(job.quantity / machine.units_per_hour * 60 + machine.setup_minutes))
            start = model.NewIntVar(0, horizon, f'start_{job.code}_{machine.code}')
            end = model.NewIntVar(0, horizon + duration, f'end_{job.code}_{machine.code}')
            selected = model.NewBoolVar(f'use_{job.code}_{machine.code}')
            interval = model.NewOptionalIntervalVar(start, duration, end, selected, f'int_{job.code}_{machine.code}')
            starts[key], ends[key], intervals[key], assignments[key] = start, end, interval, selected
        model.Add(sum(assignments[(job.code, m.code)] for m in data.machines) == 1)
        due = round(((job.due_date or epoch) - epoch).total_seconds() / 60)
        late = model.NewIntVar(0, horizon + 100000, f'late_{job.code}')
        lateness[job.code] = late
        selected_ends = [ends[(job.code, m.code)] for m in data.machines]
        for m in data.machines:
            model.Add(late >= ends[(job.code, m.code)] - due).OnlyEnforceIf(assignments[(job.code, m.code)])
        model.Add(late >= 0)
    for machine in data.machines:
        model.AddNoOverlap([intervals[(job.code, machine.code)] for job in data.jobs])
    objective = sum(lateness[j.code] * max(1, 100 - j.priority) for j in data.jobs)
    model.Minimize(objective)
    solver = cp_model.CpSolver(); solver.parameters.max_time_in_seconds = 5
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {'feasible': False, 'reason': 'CP-SAT 在给定时间窗内找不到可行排产', 'algorithm': 'cp-sat-v1'}
    result = []
    for job in data.jobs:
        for machine in data.machines:
            key = (job.code, machine.code)
            if solver.Value(assignments[key]):
                start = epoch + timedelta(minutes=solver.Value(starts[key]))
                end = epoch + timedelta(minutes=solver.Value(ends[key]))
                result.append({'job_code': job.code, 'machine_code': machine.code, 'scheduled_start': start, 'scheduled_end': end, 'lateness_minutes': solver.Value(lateness[job.code])})
    return {'feasible': True, 'objective': solver.ObjectiveValue(), 'assignments': result, 'algorithm': 'cp-sat-v1'}
