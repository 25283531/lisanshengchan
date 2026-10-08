package com.molding.mes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.molding.mes.data.DeviceItem
import com.molding.mes.data.DeviceListData
import com.molding.mes.data.MaintenanceOverview
import com.molding.mes.data.MaintenancePlan
import com.molding.mes.data.Repo
import com.molding.mes.data.Session
import com.molding.mes.ui.theme.Err
import com.molding.mes.ui.theme.Ok
import com.molding.mes.ui.theme.Warn

/**
 * 设备维修与保养：技术员在手机上提交计划、推进状态；
 * 其他角色也能看到设备当前状态与计划进展（接收设备维护状态）。
 */
@Composable
fun MaintenanceScreen() {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var overview by remember { mutableStateOf<MaintenanceOverview?>(null) }
    var plans by remember { mutableStateOf<List<MaintenancePlan>>(emptyList()) }
    var devices by remember { mutableStateOf<DeviceListData?>(null) }
    var creating by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val canWrite = Session.can("maintenance.write")

    suspend fun load() {
        loading = true; error = null
        runCatching {
            overview = Repo.maintenanceOverview().getOrNull()
            plans = Repo.maintenancePlans().getOrDefault(emptyList())
            if (canWrite) devices = Repo.maintenanceDevices().getOrNull()
        }.onFailure { error = it.message }
        loading = false
    }

    LaunchedEffect(Unit) { load() }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionTitle("设备维护状态", overview?.let { "待处理 ${it.open_count} 项" })

        overview?.counts?.let { c ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MiniStat("待安排", c.planned, Warn, Modifier.weight(1f))
                MiniStat("进行中", c.doing, Warn, Modifier.weight(1f))
                MiniStat("故障机台", c.machine_fault, Err, Modifier.weight(1f))
                MiniStat("保养模具", c.mold_maintenance, Ok, Modifier.weight(1f))
            }
        }

        if (loading) LoadingBox()
        error?.let { ErrorBox(it) { } }
        toast?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary) }

        SectionTitle("机台状态")
        val machines = overview?.machines ?: emptyList()
        if (machines.isEmpty()) EmptyBox("尚未建档机台")
        else machines.forEach { DeviceRow(it) }

        SectionTitle("模具状态")
        val molds = overview?.molds ?: emptyList()
        if (molds.isEmpty()) EmptyBox("尚未建档模具")
        else molds.forEach { DeviceRow(it) }

        val due = overview?.mold_due ?: emptyList()
        if (due.isNotEmpty()) {
            SectionTitle("保养临界模具", "接近或已超过保养阈值模次")
            due.forEach { d ->
                Card(Modifier.fillMaxWidth().padding(bottom = 6.dp), elevation = CardDefaults.cardElevation(1.dp)) {
                    Column(Modifier.padding(10.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("${d.name ?: d.code}", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                            Tag(if (d.overdue) "已超阈值" else "即将到期", if (d.overdue) Err else Warn)
                        }
                        Text("累计 ${d.cumulative_shots} / 阈值 ${d.maintenance_at_shots} 模次，剩余 ${d.remaining_shots}", fontSize = 12.sp)
                    }
                }
            }
        }

        SectionTitle("维修与保养计划", "共 ${plans.size} 条")
        if (canWrite) {
            Button(onClick = { creating = true }, modifier = Modifier.fillMaxWidth()) { Text("提交维修 / 保养计划") }
        }
        if (plans.isEmpty() && !loading) EmptyBox("暂无维修保养计划")
        plans.forEach { p ->
            Card(Modifier.fillMaxWidth().padding(bottom = 8.dp), elevation = CardDefaults.cardElevation(1.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${p.target_type_zh ?: p.target_type} ${p.target_code}", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Tag(p.status_zh ?: p.status, statusColor(p.status))
                    }
                    Text("${p.kind_zh ?: p.kind} · ${p.duration_minutes} 分钟 · ${p.created_by_name ?: ""}", fontSize = 12.sp)
                    p.fault_desc?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .75f)) }
                    p.result_note?.let { Text("结果：$it", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .75f)) }
                    Text("单号 ${p.code}", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .45f))

                    if (canWrite && (p.status == "PLANNED" || p.status == "DOING")) {
                        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (p.status == "PLANNED") {
                                Button(onClick = {
                                    scope.launch {
                                        val r = Repo.setMaintenanceStatus(p.id, "DOING", "已在手机端开始处理")
                                        toast = if (r.isSuccess) "已开始处理，设备置为维护中" else "操作失败：${r.exceptionOrNull()?.message}"
                                        load()
                                    }
                                }) { Text("开始处理") }
                            }
                            if (p.status == "DOING") {
                                Button(onClick = {
                                    scope.launch {
                                        val r = Repo.setMaintenanceStatus(p.id, "DONE", "手机端确认完成")
                                        toast = if (r.isSuccess) "已完成，设备恢复可用" else "操作失败：${r.exceptionOrNull()?.message}"
                                        load()
                                    }
                                }) { Text("处理完成") }
                            }
                            OutlinedButton(onClick = {
                                scope.launch {
                                    val r = Repo.setMaintenanceStatus(p.id, "CANCELED", "手机端取消")
                                    toast = if (r.isSuccess) "已取消" else "操作失败：${r.exceptionOrNull()?.message}"
                                    load()
                                }
                            }) { Text("取消") }
                        }
                    }
                }
            }
        }
    }

    if (creating) {
        CreatePlanDialog(
            devices = devices,
            onDismiss = { creating = false },
            onSubmit = { type, code, kind, desc, minutes ->
                scope.launch {
                    val r = Repo.createMaintenancePlan(type, code, kind, desc, minutes)
                    creating = false
                    toast = if (r.isSuccess) "计划已提交" else "提交失败：${r.exceptionOrNull()?.message}"
                    load()
                }
            },
        )
    }
}

@Composable
private fun MiniStat(label: String, value: Int, color: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier) {
    Card(modifier = modifier, elevation = CardDefaults.cardElevation(1.dp)) {
        Column(Modifier.padding(10.dp)) {
            Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))
            Text("$value", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = color)
        }
    }
}

@Composable
private fun DeviceRow(d: DeviceItem) {
    Card(Modifier.fillMaxWidth().padding(bottom = 6.dp), elevation = CardDefaults.cardElevation(1.dp)) {
        Row(Modifier.fillMaxWidth().padding(10.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text(d.name ?: d.code, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Text(d.code + (d.current_mold_code?.let { " · 机上模具 $it" } ?: ""), fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = .55f))
            }
            Tag(deviceStatusZh(d.status), statusColor(d.status))
        }
    }
}

private fun deviceStatusZh(s: String?): String = when (s) {
    "AVAILABLE" -> "可用"
    "FAULT" -> "故障"
    "MAINTENANCE" -> "维护中"
    "RETIRED" -> "已停用"
    else -> s ?: "未知"
}

private fun statusColor(s: String?): androidx.compose.ui.graphics.Color = when (s) {
    "AVAILABLE", "DONE" -> Ok
    "FAULT", "CANCELED" -> Err
    else -> Warn
}

@Composable
private fun CreatePlanDialog(
    devices: DeviceListData?,
    onDismiss: () -> Unit,
    onSubmit: (targetType: String, targetCode: String, kind: String, faultDesc: String, minutes: Int) -> Unit,
) {
    val types = listOf("机台" to "MACHINE", "模具" to "MOLD")
    val kinds = listOf("故障维修" to "REPAIR", "预防保养" to "MAINTAIN", "换模检修" to "MOLD_CHANGE")
    var typeLabel by remember { mutableStateOf(types.first().first) }
    var kindLabel by remember { mutableStateOf(kinds.first().first) }
    var code by remember { mutableStateOf("") }
    var desc by remember { mutableStateOf("") }
    var minutes by remember { mutableStateOf("60") }
    var err by remember { mutableStateOf<String?>(null) }

    val targetType = types.first { it.first == typeLabel }.second
    val options = if (targetType == "MOLD") devices?.molds.orEmpty() else devices?.machines.orEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("提交维修 / 保养计划") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f)) { SimpleDropdown("设备类型", types.map { it.first }, typeLabel) { typeLabel = it } }
                    Box(Modifier.weight(1f)) { SimpleDropdown("计划类型", kinds.map { it.first }, kindLabel) { kindLabel = it } }
                }
                if (options.isEmpty()) {
                    Text("尚未建档${if (targetType == "MOLD") "模具" else "机台"}", fontSize = 12.sp)
                    OutlinedTextField(value = code, onValueChange = { code = it }, label = { Text("设备编号") },
                        singleLine = true, modifier = Modifier.fillMaxWidth())
                } else {
                    SimpleDropdown("设备", options.map { it.code }, code.ifBlank { options.first().code }) { code = it }
                }
                OutlinedTextField(value = desc, onValueChange = { desc = it }, label = { Text("故障/保养说明") },
                    modifier = Modifier.fillMaxWidth(), maxLines = 3)
                OutlinedTextField(value = minutes, onValueChange = { minutes = it.filter { c -> c.isDigit() } },
                    label = { Text("预计时长（分钟）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                err?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
            }
        },
        confirmButton = {
            Button(onClick = {
                val m = minutes.toIntOrNull()
                when {
                    code.isBlank() -> err = "请选择或填写设备编号"
                    m == null || m <= 0 -> err = "请填写预计时长"
                    else -> onSubmit(targetType, code.trim(), kinds.first { it.first == kindLabel }.second, desc.trim(), m)
                }
            }) { Text("提交") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun SimpleDropdown(label: String, items: List<String>, selected: String, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
            Text("$label：${selected.ifBlank { "请选择" }}", fontSize = 12.sp)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            items.forEach { n -> DropdownMenuItem(text = { Text(n) }, onClick = { onSelect(n); expanded = false }) }
        }
    }
}
