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
import com.molding.mes.data.MaterialGroup
import com.molding.mes.data.NotificationItem
import com.molding.mes.data.Repo
import com.molding.mes.data.Session
import com.molding.mes.data.ShiftItem

/** 首页：按角色展示各自最关心的内容 + 最新消息 */
@Composable
fun HomeScreen(onOpenAssistant: () -> Unit) {
    val role = Session.role
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var shift by remember { mutableStateOf<List<ShiftItem>>(emptyList()) }
    var materials by remember { mutableStateOf<List<MaterialGroup>>(emptyList()) }
    var notes by remember { mutableStateOf<List<NotificationItem>>(emptyList()) }
    var unread by remember { mutableStateOf(0) }

    suspend fun load() {
        loading = true; error = null
        runCatching {
            unread = Repo.unreadCount().getOrDefault(0)
            notes = Repo.notifications(30).getOrDefault(emptyList())
            when (role) {
                "PRODUCTION" -> shift = Repo.shift(12).getOrNull()?.items ?: emptyList()
                "MIXER", "WAREHOUSE" -> materials = Repo.materials().getOrNull()?.items ?: emptyList()
                "TECHNICIAN" -> notes = Repo.notifications(30, type = null).getOrDefault(emptyList())
                else -> Unit
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
            else -> {
                SectionTitle("快捷操作")
                TextButton(onClick = onOpenAssistant) { Text("用一句话下单 / 出库 / 报工") }
            }
        }

        SectionTitle("最新消息", "共 ${notes.size} 条")
        if (notes.isEmpty()) EmptyBox("暂无消息")
        else notes.take(12).forEach { NoteCard(it) }
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
