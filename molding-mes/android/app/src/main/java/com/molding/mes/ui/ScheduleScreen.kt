package com.molding.mes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import com.molding.mes.data.OrderItem
import com.molding.mes.data.Repo
import com.molding.mes.data.ScheduleTask
import com.molding.mes.data.Session

/** 排产与订单：生产人员看到的是自己机台的任务，其他角色看全量 */
@Composable
fun ScheduleScreen() {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var tasks by remember { mutableStateOf<List<ScheduleTask>>(emptyList()) }
    var orders by remember { mutableStateOf<List<OrderItem>>(emptyList()) }

    suspend fun load() {
        loading = true; error = null
        runCatching {
            val bound = Session.machineCode
            val all = Repo.tasks().getOrDefault(emptyList())
            tasks = if (Session.role == "PRODUCTION" && !bound.isNullOrBlank()) all.filter { it.machine_code == bound } else all
            orders = Repo.orders().getOrDefault(emptyList())
        }.onFailure { error = it.message }
        loading = false
    }
    LaunchedEffect(Unit) { load() }

    androidx.compose.foundation.layout.Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (loading) LoadingBox()
        error?.let { ErrorBox(it) { } }

        SectionTitle("排产任务", "共 ${tasks.size} 项")
        if (tasks.isEmpty()) EmptyBox("暂无排产任务")
        else tasks.forEach { t ->
            Card(Modifier.fillMaxWidth().padding(bottom = 8.dp), elevation = CardDefaults.cardElevation(1.dp)) {
                androidx.compose.foundation.layout.Column(Modifier.padding(12.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${t.product_name ?: "-"}　${t.planned_qty} 个", fontWeight = FontWeight.SemiBold)
                        Tag(decisionZh(t.decision), if (t.decision == "CHANGE_MOLD") com.molding.mes.ui.theme.Warn else com.molding.mes.ui.theme.Brand)
                    }
                    Text("机台 ${t.machine_code}　模具 ${t.mold_code}", fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = .7f))
                    Text("${t.start_at?.take(16) ?: ""} ~ ${t.end_at?.take(16) ?: ""}", fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))
                }
            }
        }

        SectionTitle("订单", "共 ${orders.size} 张")
        if (orders.isEmpty()) EmptyBox("暂无订单")
        else orders.forEach { o ->
            Card(Modifier.fillMaxWidth().padding(bottom = 6.dp), elevation = CardDefaults.cardElevation(0.dp)) {
                androidx.compose.foundation.layout.Column(Modifier.padding(12.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${o.product_name ?: "-"}", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Tag(orderStatusZh(o.status), orderStatusColor(o.status))
                    }
                    Text("${o.code}　${o.customer_name ?: "无客户"}", fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = .55f))
                    Text("订单 ${o.quantity}　待生产 ${o.remaining_qty}　已完工 ${o.completed_qty}　交期 ${o.due_date ?: "未定"}",
                        fontSize = 12.sp)
                }
            }
        }
    }
}
