package com.molding.mes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.molding.mes.ui.theme.Brand
import com.molding.mes.ui.theme.Err
import com.molding.mes.ui.theme.Ok
import com.molding.mes.ui.theme.Warn

@Composable
fun SectionTitle(text: String, extra: String? = null) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        extra?.let {
            Text(
                it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f),
                modifier = Modifier.padding(start = 8.dp)
            )
        }
    }
}

@Composable
fun StatCard(label: String, value: String, hint: String? = null) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))
            Text(value, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            hint?.let { Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f)) }
        }
    }
}

@Composable
fun Tag(text: String, color: Color = Brand) {
    Box(
        Modifier
            .border(1.dp, color.copy(alpha = .4f), RoundedCornerShape(20.dp))
            .background(color.copy(alpha = .12f), RoundedCornerShape(20.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp)
    ) {
        Text(text, fontSize = 11.sp, color = color)
    }
}

fun levelColor(level: String?): Color = when (level) {
    "ERROR" -> Err
    "WARN" -> Warn
    "OK" -> Ok
    else -> Brand
}

/* ------------------------- 服务端枚举的中文显示 ------------------------- */

/** 订单状态 → 中文（与服务端 orders/schedule 模块的枚举保持一致） */
fun orderStatusZh(s: String?): String = when (s) {
    "DRAFT" -> "待排产"
    "SCHEDULED" -> "已排产"
    "RUNNING", "PRODUCING" -> "生产中"
    "COMPLETED" -> "已完工"
    "CANCELLED", "CANCELED" -> "已取消"
    else -> s ?: "-"
}

/** 订单状态 → 标签颜色 */
fun orderStatusColor(s: String?): Color = when (s) {
    "DRAFT" -> Warn
    "SCHEDULED" -> Brand
    "RUNNING", "PRODUCING" -> Ok
    "COMPLETED" -> Ok
    "CANCELLED", "CANCELED" -> Err
    else -> Brand
}

/** 排产换模决策 → 中文（KEEP_CURRENT_MOLD / CHANGE_MOLD / ACTIVATE_IDLE_MACHINE） */
fun decisionZh(s: String?): String = when (s) {
    "KEEP_CURRENT_MOLD" -> "沿用模具"
    "CHANGE_MOLD" -> "需换模"
    "ACTIVATE_IDLE_MACHINE" -> "启动机台"
    else -> s ?: "-"
}

/** 权限点 → 中文（与服务端 rbac.js 的权限矩阵一一对应） */
val PERMISSION_ZH: Map<String, String> = mapOf(
    "master.read" to "台账查看",
    "master.write" to "台账维护",
    "stock.write" to "库存调整",
    "order.read" to "订单查看",
    "order.create" to "提交订单",
    "order.update" to "修改订单",
    "order.outbound" to "报工出库",
    "maintenance.read" to "维保查看",
    "maintenance.write" to "维保提交",
    "schedule.read" to "排产查看",
    "schedule.run" to "排产执行",
    "material.read" to "配料查看",
    "material.write" to "原料出入库",
    "employee.manage" to "员工授权",
    "tenant.config" to "公司配置",
    "notify.read" to "消息接收",
    "chat.use" to "AI 助手",
    "audit.read" to "审计日志",
    "wx.manage" to "小程序授权",
)

@Composable
fun LoadingBox(text: String = "加载中…") {
    Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
        Text(text, modifier = Modifier.padding(top = 56.dp), fontSize = 12.sp)
    }
}

@Composable
fun EmptyBox(text: String) {
    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))
    }
}

@Composable
fun ErrorBox(message: String, onRetry: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxWidth().padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(message, color = Err, fontSize = 13.sp)
        onRetry?.let { androidx.compose.material3.TextButton(onClick = it) { Text("重试") } }
    }
}
