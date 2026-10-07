package com.molding.mes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
 */
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

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            samples.forEach { s ->
                AssistChip(onClick = { text = s; send(s) }, label = { Text(s, fontSize = 11.sp) })
            }
        }

        OutlinedTextField(
            value = text, onValueChange = { text = it },
            label = { Text("例如：河北的魔辣面筋下2万个订单，13号交货") },
            modifier = Modifier.fillMaxWidth(), minLines = 2,
        )

        Button(onClick = { send(text) }, modifier = Modifier.fillMaxWidth(), enabled = !loading) {
            if (loading) CircularProgressIndicator(Modifier.padding(end = 8.dp))
            Text("发送")
        }

        error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }

        result?.let { r ->
            Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(1.dp)) {
                Column(Modifier.padding(14.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("意图：${r.intent}", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Tag(if (r.used_fallback) "本地解析" else "AI 解析")
                    }
                    Text("置信度 ${String.format("%.2f", r.confidence)}", fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))
                    r.message?.let {
                        Text(it, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
                    }
                    if (r.needs_confirm && r.candidates.isNotEmpty()) {
                        Text("需要从以下候选中确认：", fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(top = 8.dp))
                        r.candidates.forEach { c ->
                            Text("· ${c.get("field")?.asString}：${c.get("input")?.asString ?: "（未识别）"}", fontSize = 12.sp)
                        }
                    }
                }
            }
        }

        Text(
            "解析不出来的实体会列成候选让你确认，不会拿估算值硬填。",
            fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f)
        )
    }
}
