package com.molding.mes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.molding.mes.data.Repo
import com.molding.mes.data.Session
import kotlinx.coroutines.launch

/**
 * 登录页。
 * 关键提示：只有公司管理员在后台录入过的手机号才能登录，
 * 未授权的号码会收到明确报错并提示联系管理员。
 */
@Composable
fun LoginScreen(onLoggedIn: () -> Unit) {
    val scope = rememberCoroutineScope()
    var phone by remember { mutableStateOf(Session.phone) }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var tenantCode by remember { mutableStateOf(Session.tenantCode) }
    var useSms by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("注塑生产协同", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Text("小批量注塑包装盒 · 排产 / 库存 / 设备协同", fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))

        Column(Modifier.padding(top = 28.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = tenantCode, onValueChange = { tenantCode = it },
                label = { Text("公司编码") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = phone, onValueChange = { phone = it },
                label = { Text("手机号") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            if (useSms) {
                OutlinedTextField(
                    value = code, onValueChange = { code = it },
                    label = { Text("验证码") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
            } else {
                OutlinedTextField(
                    value = password, onValueChange = { password = it },
                    label = { Text("密码") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation(),
                )
            }

            Button(
                onClick = {
                    error = null; info = null; loading = true
                    scope.launch {
                        val r = if (useSms) Repo.loginSms(phone.trim(), code.trim(), tenantCode.trim())
                        else Repo.login(phone.trim(), password, tenantCode.trim())
                        loading = false
                        r.onSuccess { Session.saveLogin(it); onLoggedIn() }
                            .onFailure { error = it.message }
                    }
                },
                modifier = Modifier.fillMaxWidth(), enabled = !loading,
            ) {
                if (loading) CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp))
                Text(if (useSms) "验证码登录" else "登录")
            }

            if (useSms) {
                TextButton(onClick = {
                    scope.launch {
                        Repo.sendSms(phone.trim(), tenantCode.trim())
                            .onSuccess { info = "演示模式验证码：${it["demo_code"]}" }
                            .onFailure { error = it.message }
                    }
                }) { Text("发送验证码") }
            }

            TextButton(onClick = { useSms = !useSms }) {
                Text(if (useSms) "用密码登录" else "用验证码登录")
            }

            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            info?.let { Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.primary) }

            Text(
                "未授权手机号无法登录，请联系贵公司管理员在后台录入。",
                fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f),
                modifier = Modifier.padding(top = 16.dp)
            )
        }
    }
}
