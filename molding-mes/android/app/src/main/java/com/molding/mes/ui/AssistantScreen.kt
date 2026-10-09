package com.molding.mes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.molding.mes.data.ChatResult
import com.molding.mes.data.Repo
import com.molding.mes.data.Session
import kotlinx.coroutines.launch

/**
 * 助手页：说一句话就办事。
 * 例：河北的魔辣面筋下 2 万个订单，13 号交货 / 河北麻辣面筋出库 5000 个
 *
 * 展示口径与服务端一致：意图 + 置信度 + 解析明细；识别不准的实体列成候选让人确认。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AssistantScreen() {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var result by remember { mutableStateOf<ChatResult?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val samples = when (Session.role) {
        "SALES" -> listOf("河北的魔辣面筋下2万个订单，13号交货", "山东通用盒下8000个，20号交货", "魔辣面筋库存还有多少")
        "PRODUCTION" -> listOf("河北麻辣面筋出库5000个", "魔辣面筋报工3000个", "今天排产怎么安排的")
        "MIXER" -> listOf("魔辣面筋需要多少料", "PP 库存还有多少")
        "WAREHOUSE" -> listOf("PP 库存还有多少", "魔辣面筋出库5000个")
        else -> listOf("河北的魔辣面筋下2万个订单，13号交货", "PP 库存还有多少")
    }

    fun send(t: String) {
        if (t.isBlank()) return
        error = null; loading = true
        scope.launch {
            Repo.chat(t)
                .onSuccess { result = it }
                .onFailure { error = it.message; result = null }
            loading = false
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionTitle("说一句话就办事")

        // FlowRow：示例多的时候自动换行，不再横向挤成一团或溢出屏幕
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            samples.forEach { s ->
                AssistChip(onClick = { text = s; send(s) }, label = { Text(s, fontSize = 11.sp) })
            }
        }

        OutlinedTextField(
            value = text, onValueChange = { text = it },
            label = { Text("例如：河北的魔辣面筋下2万个订单，13号交货") },
            modifier = Modifier.fillMaxWidth(), minLines = 2,
        )

        Button(onClick = { send(text) }, modifier = Modifier.fillMaxWidth(), enabled = !loading && text.isNotBlank()) {
            if (loading) {
                CircularProgressIndicator(Modifier.padding(end = 8.dp))
                Text("AI 解析中…")
            } else {
                Text("发送")
            }
        }

        error?.let {
            Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(0.dp)) {
                Text(
                    it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp,
                    modifier = Modifier.padding(12.dp),
                )
            }
        }

        result?.let { r -> ChatResultCard(r) }

        Text(
            "语义解析优先调用 AI，AI 不可用时仅下单 / 出库 / 报工 / 库存 / 设备状态可本地兜底；" +
                "解析不出来的实体会列成候选让你确认，不会拿估算值硬填。",
            fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f)
        )
    }
}

/** 解析结果卡片：意图、置信度、解析明细、待确认候选 */
@Composable
private fun ChatResultCard(r: ChatResult) {
    Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(1.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(intentZh(r.intent), fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Tag(
                    if (r.ai_unavailable) "AI 不可用"
                    else if (r.degraded || r.used_fallback) "本地解析"
                    else "AI 解析",
                    if (r.ai_unavailable) com.molding.mes.ui.theme.Err else levelColor("OK"),
                )
            }
            Text("置信度 ${String.format("%.2f", r.confidence)}", fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))

            r.message?.let {
                HorizontalDivider()
                Text(
                    it, fontSize = 13.sp,
                    color = if (r.ai_unavailable) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurface,
                )
            }

            // 解析明细：字段中文名 + 值，让用户看清 AI 到底理解成了什么
            r.parsed?.let { p ->
                if (r.needs_confirm) return@let
                HorizontalDivider()
                ParsedRow("产品", p["product"])
                ParsedRow("客户", p["customer"])
                ParsedRow("原料", p["material"])
                ParsedRow("数量", p["quantity"])
                ParsedRow("单位", p["unit"])
                ParsedRow("交期", p["due_date"])
                fmtVal(p["note"])?.let {
                    Text(it, fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = .55f))
                }
            }

            if (r.needs_confirm && r.candidates.isNotEmpty()) {
                HorizontalDivider()
                Text("请补充或确认：", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                r.candidates.forEach { c ->
                    Text(
                        "· ${candidateFieldZh(c["field"] as? String)}：${fmtVal(c["input"]) ?: "（未识别）"}",
                        fontSize = 12.sp,
                    )
                }
                Text("可在上方补充说明后重新发送，例如写全产品名称。", fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))
            }
        }
    }
}

@Composable
private fun ParsedRow(label: String, value: Any?) {
    val v = fmtVal(value) ?: return
    Text("$label：$v", fontSize = 13.sp)
}

/** Map 里的值经 Gson 反序列化可能是 Double/Long/String/嵌套 Map，统一成可读文本 */
private fun fmtVal(v: Any?): String? = when (v) {
    null -> null
    is String -> v.trim().takeIf { it.isNotEmpty() }
    is Number -> if (v.toDouble() % 1.0 == 0.0) v.toLong().toString() else v.toString()
    is Map<*, *> -> null
    else -> v.toString().takeIf { it.isNotBlank() }
}

/** 意图 → 中文 */
private fun intentZh(i: String): String = when (i) {
    "CREATE_ORDER" -> "创建订单"
    "UPDATE_ORDER" -> "修改订单"
    "OUTBOUND" -> "成品出库"
    "PROGRESS" -> "生产报工"
    "QUERY_STOCK" -> "库存查询"
    "QUERY_SCHEDULE" -> "排产查询"
    "QUERY_PROGRESS" -> "进度查询"
    "MACHINE_STATUS" -> "设备状态"
    "MASTER_CREATE" -> "建档"
    "MASTER_UPDATE" -> "改台账"
    "MAINTENANCE_PLAN" -> "维修保养"
    "UNKNOWN" -> "未识别"
    else -> i
}

/** 候选字段 → 中文 */
private fun candidateFieldZh(f: String?): String = when (f) {
    "product" -> "产品"
    "customer" -> "客户"
    "material" -> "原料"
    "machine" -> "机台"
    "mold" -> "模具"
    else -> f ?: "实体"
}
