package com.molding.mes.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.gson.JsonObject
import com.molding.mes.data.MaterialGroup
import com.molding.mes.data.NotificationItem
import com.molding.mes.data.OrderItem
import com.molding.mes.data.Repo
import com.molding.mes.data.ScheduleTask
import com.molding.mes.data.Session
import com.molding.mes.data.ShiftItem
import com.molding.mes.ui.theme.Err
import com.molding.mes.ui.theme.Ok
import com.molding.mes.ui.theme.Warn
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 首页：按角色展示各自最关心的内容 + 最新消息。
 * 内容分组与 Web 端（Docker 后台）的权限矩阵保持一致：
 *   BOSS 老板 → 库存概览 + 生产实况；PMC → 排产与交期风险；SALES → 订单概况；
 *   PRODUCTION → 当班任务；MIXER/WAREHOUSE → 配料计划；TECHNICIAN → 设备提醒。
 * 提交类操作仍由服务端权限（permissions）控制，页面内按 Session.can() 显隐。
 */
@Composable
fun HomeScreen(
    onOpenAssistant: () -> Unit,
    onOpenOrders: () -> Unit = {},
    onOpenMaintenance: () -> Unit = {},
) {
    val role = Session.role
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var shift by remember { mutableStateOf<List<ShiftItem>>(emptyList()) }
    var materials by remember { mutableStateOf<List<MaterialGroup>>(emptyList()) }
    var notes by remember { mutableStateOf<List<NotificationItem>>(emptyList()) }
    var orders by remember { mutableStateOf<List<OrderItem>>(emptyList()) }
    var tasks by remember { mutableStateOf<List<ScheduleTask>>(emptyList()) }
    var master by remember { mutableStateOf<JsonObject?>(null) }
    var unread by remember { mutableStateOf(0) }

    suspend fun load() {
        loading = true; error = null
        runCatching {
            unread = Repo.unreadCount().getOrDefault(0)
            notes = Repo.notifications(30).getOrDefault(emptyList())
            when {
                // 当班任务：生产人员
                Session.can("order.read") && role == "PRODUCTION" ->
                    shift = Repo.shift(12).getOrNull()?.items ?: emptyList()
                // 配料计划：配料员 / 仓库
                Session.can("material.read") && role in listOf("MIXER", "WAREHOUSE") ->
                    materials = Repo.materials().getOrNull()?.items ?: emptyList()
                // 库存 + 生产实况：老板（与 Web 端 BOSS 视图一致）
                Session.can("material.read") && role == "BOSS" -> {
                    master = Repo.master().getOrNull()
                    tasks = Repo.tasks().getOrDefault(emptyList())
                }
                // 排产与交期风险：PMC
                role == "PMC" -> {
                    tasks = Repo.tasks().getOrDefault(emptyList())
                    orders = Repo.orders().getOrDefault(emptyList())
                }
                // 订单概况：业务员
                role == "SALES" -> orders = Repo.orders().getOrDefault(emptyList())
                // 台账概况：管理员
                role == "ADMIN" -> master = Repo.master().getOrNull()
            }
        }.onFailure { error = it.message }
        loading = false
    }

    LaunchedEffect(Unit) { load() }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HomeStatCard("当前用户", Session.userName, Session.roleZh, Modifier.weight(1f))
            HomeStatCard("未读消息", "$unread 条", if (Session.machineCode == null) "未绑定机台" else "机台 ${Session.machineCode}", Modifier.weight(1f))
        }

        if (loading) LoadingBox()
        error?.let { ErrorBox(it) { } }

        // 业务入口：所有角色都能进，页面内按权限显示可提交的操作
        SectionTitle("我的业务")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            EntryCard(
                title = "订单",
                hint = if (Session.can("order.create")) "提交新订单 / 改单" else "查看订单与进度",
                modifier = Modifier.weight(1f),
                onClick = onOpenOrders,
            )
            EntryCard(
                title = "设备维护",
                hint = if (Session.can("maintenance.write")) "提交维修保养计划" else "查看设备与维护状态",
                modifier = Modifier.weight(1f),
                onClick = onOpenMaintenance,
            )
        }

        when (role) {
            "PRODUCTION" -> ShiftBlock(shift)
            "MIXER" -> MaterialBlock(materials)
            "WAREHOUSE" -> MaterialBlock(materials, title = "库存与配料需求")
            "TECHNICIAN" -> {
                SectionTitle("模具与设备提醒")
                val alerts = notes.filter { it.type in listOf("MOLD_CHANGE", "MOLD_MAINTENANCE", "MACHINE_FAULT") }
                if (alerts.isEmpty()) EmptyBox("暂无换模或保养提醒")
                else alerts.forEach { NoteCard(it) }
            }
            "BOSS" -> BossBlock(master, tasks)
            "PMC" -> PmcBlock(tasks, orders)
            "SALES" -> SalesBlock(orders)
            "ADMIN" -> AdminBlock(master)
        }

        SectionTitle("最新消息", "共 ${notes.size} 条")
        if (notes.isEmpty()) EmptyBox("暂无消息")
        else notes.take(12).forEach { NoteCard(it) }
    }
}

/** 业务入口卡片 */
@Composable
private fun EntryCard(title: String, hint: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Card(
        modifier = modifier.clickable { onClick() },
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(hint, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))
        }
    }
}

@Composable
private fun HomeStatCard(label: String, value: String, hint: String, modifier: Modifier = Modifier) {
    Card(modifier = modifier, elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)) {
        Column(Modifier.padding(12.dp)) {
            Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))
            Text(value, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text(hint, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))
        }
    }
}

/* ------------------------- 各角色的首页内容块 ------------------------- */

/** 老板：库存概览 + 生产实况（对应 Web 端 BOSS 的 inventory + production 视图） */
@Composable
private fun BossBlock(master: JsonObject?, tasks: List<ScheduleTask>) {
    SectionTitle("库存概览", "低于安全库存会标红")
    val m = master
    if (m == null) {
        EmptyBox("暂无库存数据")
    } else {
        val mats = m.getAsJsonArray("materials")?.mapNotNull { it as? JsonObject } ?: emptyList()
        val labels = m.getAsJsonArray("labels")?.mapNotNull { it as? JsonObject } ?: emptyList()
        val products = m.getAsJsonArray("products")?.mapNotNull { it as? JsonObject } ?: emptyList()
        val shortMats = mats.filter { jdouble(it, "stock_qty") < jdouble(it, "safety_stock") }
        val shortLabels = labels.filter { jdouble(it, "stock_qty") < jdouble(it, "safety_stock") }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MiniStat2("原料种类", "${mats.size}", Modifier.weight(1f))
            MiniStat2("成品品类", "${products.size}", Modifier.weight(1f))
            MiniStat2("库存预警", "${shortMats.size + shortLabels.size}", Modifier.weight(1f),
                if (shortMats.isEmpty() && shortLabels.isEmpty()) Ok else Err)
        }
        (shortMats + shortLabels).take(5).forEach { s ->
            Text(
                "· ${s.get("name")?.asString ?: s.get("sku")?.asString ?: "-"}　库存 ${jdouble(s, "stock_qty").fmt()} ${s.get("unit")?.asString ?: ""} / 安全 ${jdouble(s, "safety_stock").fmt()}",
                fontSize = 12.sp, color = Err,
            )
        }
    }

    SectionTitle("生产实况", "进行中 / 待执行的排产任务")
    if (tasks.isEmpty()) EmptyBox("当前没有排产任务")
    else {
        Text("进行中与待执行任务 ${tasks.size} 项", fontSize = 13.sp)
        tasks.take(3).forEach { t ->
            Text(
                "· ${t.product_name ?: "-"}　${t.planned_qty} 个　机台 ${t.machine_code}",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .75f),
            )
        }
    }
}

/** PMC：排产任务 + 交期风险（对应 Web 端 PMC 的 schedule 视图） */
@Composable
private fun PmcBlock(tasks: List<ScheduleTask>, orders: List<OrderItem>) {
    SectionTitle("排产任务", "共 ${tasks.size} 项")
    if (tasks.isEmpty()) EmptyBox("暂无排产任务")
    else {
        val change = tasks.count { it.decision == "CHANGE_MOLD" }
        if (change > 0) {
            Text("其中 $change 项需要换模，注意预留换模时间。", fontSize = 12.sp, color = Warn)
        }
        tasks.take(3).forEach { t ->
            Text(
                "· ${t.product_name ?: "-"}　${t.planned_qty} 个　机台 ${t.machine_code}　${decisionZh(t.decision)}",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .75f),
            )
        }
    }

    SectionTitle("交期风险")
    val today = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(Date())
    val overdue = orders.filter { !it.due_date.isNullOrBlank() && it.due_date < today && it.remaining_qty > 0 }
    if (overdue.isEmpty()) {
        Text("没有已逾期订单", fontSize = 13.sp, color = Ok)
    } else {
        Text("${overdue.size} 张订单已逾期，请关注产能与交期协商。", fontSize = 13.sp, color = Err)
        overdue.take(5).forEach { o ->
            Text("· ${o.code} ${o.product_name ?: "-"}　交期 ${o.due_date}　待生产 ${o.remaining_qty}", fontSize = 12.sp, color = Err)
        }
    }
}

/** 业务员：订单概况 */
@Composable
private fun SalesBlock(orders: List<OrderItem>) {
    SectionTitle("订单概况")
    if (orders.isEmpty()) { EmptyBox("暂无订单"); return }
    val open = orders.filter { it.remaining_qty > 0 }
    val today = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(Date())
    val dueSoon = open.filter { !it.due_date.isNullOrBlank() && it.due_date <= today }
    Text("全部 ${orders.size} 张 · 进行中 ${open.size} 张 · 交期临近 ${dueSoon.size} 张", fontSize = 13.sp)
    if (dueSoon.isNotEmpty()) {
        Text("以下订单已到或超过交期，请跟进：", fontSize = 12.sp, color = Warn,
            modifier = Modifier.padding(top = 4.dp))
        dueSoon.take(5).forEach { o ->
            Text("· ${o.code} ${o.product_name ?: "-"}　待生产 ${o.remaining_qty}　交期 ${o.due_date}", fontSize = 12.sp, color = Warn)
        }
    }
}

/** 管理员：台账概况 */
@Composable
private fun AdminBlock(master: JsonObject?) {
    SectionTitle("台账概况", "基础数据完整性")
    val m = master
    if (m == null) { EmptyBox("暂无台账数据"); return }
    fun cnt(key: String) = m.getAsJsonArray(key)?.size() ?: 0
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        MiniStat2("机台", "${cnt("machines")}", Modifier.weight(1f))
        MiniStat2("模具", "${cnt("molds")}", Modifier.weight(1f))
        MiniStat2("产品", "${cnt("products")}", Modifier.weight(1f))
        MiniStat2("客户", "${cnt("customers")}", Modifier.weight(1f))
    }
    val sparse = listOf("machines" to "机台", "molds" to "模具", "materials" to "原料", "customers" to "客户")
        .filter { cnt(it.first) == 0 }
    if (sparse.isNotEmpty()) {
        Text(
            "提示：${sparse.joinToString("、") { it.second }}尚未建档，AI 语义解析的准确度依赖台账数据，建议尽快在后台录入。",
            fontSize = 12.sp, color = Warn, modifier = Modifier.padding(top = 4.dp),
        )
    }
}

@Composable
private fun MiniStat2(label: String, value: String, modifier: Modifier = Modifier, color: androidx.compose.ui.graphics.Color? = null) {
    Card(modifier = modifier, elevation = CardDefaults.cardElevation(1.dp)) {
        Column(Modifier.padding(10.dp)) {
            Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))
            Text(value, fontSize = 17.sp, fontWeight = FontWeight.Bold, color = color ?: MaterialTheme.colorScheme.onSurface)
        }
    }
}

private fun jdouble(o: JsonObject, key: String): Double =
    o.get(key)?.takeIf { it.isJsonPrimitive }?.asDouble ?: 0.0

private fun Double.fmt(): String = if (this % 1.0 == 0.0) toLong().toString() else String.format("%.2f", this)

@Composable
private fun ShiftBlock(items: List<ShiftItem>) {
    SectionTitle("当班生产任务", "未来 12 小时")
    if (items.isEmpty()) { EmptyBox("本班暂无任务"); return }
    items.forEach { i ->
        Card(Modifier.fillMaxWidth().padding(bottom = 8.dp), elevation = CardDefaults.cardElevation(1.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text("${i.product_name ?: i.product_sku ?: "-"}　${i.planned_qty} 个", fontWeight = FontWeight.SemiBold)
                Text("机台 ${i.machine_code}　模具 ${i.mold_code}", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = .7f))
                Text("${i.window_start?.take(16) ?: ""} ~ ${i.window_end?.take(16) ?: ""}", fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))
            }
        }
    }
}

@Composable
private fun MaterialBlock(items: List<MaterialGroup>, title: String = "配料计划") {
    SectionTitle(title, "每种原料的预估用量、使用时间与混料机")
    if (items.isEmpty()) { EmptyBox("暂无配料计划"); return }
    items.forEach { g ->
        Card(Modifier.fillMaxWidth().padding(bottom = 8.dp), elevation = CardDefaults.cardElevation(1.dp)) {
            Column(Modifier.padding(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${g.name ?: g.sku}", fontWeight = FontWeight.SemiBold)
                    Tag(if (g.kind == "LABEL") "标签" else "原料")
                }
                Text("合计 ${fmt(g.total_qty)} ${g.unit}", fontSize = 13.sp)
                g.details.take(4).forEach { d ->
                    Text(
                        "· ${d.use_at?.take(16) ?: "-"}　${fmt(d.qty)} ${g.unit}　${d.mixer_code?.let { "混料机 $it" } ?: "机边桶"}",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .75f)
                    )
                }
            }
        }
    }
}

@Composable
fun NoteCard(n: NotificationItem, onRead: (() -> Unit)? = null) {
    Card(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .let { if (onRead != null) it.clickable { onRead() } else it },
        elevation = CardDefaults.cardElevation(if (n.is_read) 0.dp else 1.dp),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(n.title, fontWeight = if (n.is_read) FontWeight.Normal else FontWeight.SemiBold, fontSize = 14.sp)
                Tag(n.type, levelColor(n.level))
            }
            n.body?.let {
                Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .75f),
                    modifier = Modifier.padding(top = 4.dp))
            }
            Text(n.created_at?.take(16) ?: "", fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = .45f))
        }
    }
}

private fun fmt(v: Double): String = if (v % 1.0 == 0.0) v.toLong().toString() else String.format("%.2f", v)
