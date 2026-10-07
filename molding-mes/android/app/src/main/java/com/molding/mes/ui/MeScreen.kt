package com.molding.mes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.molding.mes.data.Session
import com.molding.mes.worker.PollWorker

@Composable
fun MeScreen(onLogout: () -> Unit) {
    var baseUrl by remember { mutableStateOf(Session.baseUrl) }
    var saved by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(1.dp)) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(Session.userName, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text("${Session.roleZh}　${Session.phone}", fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = .7f))
                Text(
                    if (Session.machineCode.isNullOrBlank()) "未绑定机台（接收全部机台消息）" else "已绑定机台 ${Session.machineCode}",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f)
                )
            }
        }

        SectionTitle("服务端地址")
        OutlinedTextField(
            value = baseUrl, onValueChange = { baseUrl = it },
            label = { Text("Base URL") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { Session.baseUrl = baseUrl; saved = "已保存：${Session.baseUrl}" }, Modifier.fillMaxWidth()) {
            Text("保存并重连")
        }
        saved?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary) }
        Text("车间内网部署时填实际服务器地址，例如 http://192.168.1.50:8080/", fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))

        SectionTitle("消息推送")
        Text("后台每 15 分钟轮询一次新消息并弹出通知。", fontSize = 12.sp)
        Button(onClick = { PollWorker.enable(androidx.compose.ui.platform.LocalContext.current) }, Modifier.fillMaxWidth()) {
            Text("开启轮询")
        }
        Button(onClick = { PollWorker.disable(androidx.compose.ui.platform.LocalContext.current) }, Modifier.fillMaxWidth()) {
            Text("关闭轮询")
        }

        Button(onClick = { Session.clear(); onLogout() }, Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Text("退出登录")
        }
    }
}
