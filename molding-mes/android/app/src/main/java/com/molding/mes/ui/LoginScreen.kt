package com.molding.mes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import com.molding.mes.data.LoginData
import com.molding.mes.data.Repo
import com.molding.mes.data.Session
import kotlinx.coroutines.launch

/**
 * 登录页：手机号 + 密码。
 *
 * 两条硬规则：
 *  1. 只有公司管理员在后台录入过的手机号才能登录，未授权的号码会收到明确报错。
 *  2. 密码由管理员下发（初始密码），首次登录成功后 APP 提示是否修改，**员工可自行选择**：
 *     改则输入新密码，不改则点「以后再说」保留初始密码，后续可在「我的」页随时修改。
 */
@Composable
fun LoginScreen(onLoggedIn: () -> Unit) {
    val scope = rememberCoroutineScope()
    var phone by remember { mutableStateOf(Session.phone) }
    var password by remember { mutableStateOf("") }
    var tenantCode by remember { mutableStateOf(Session.tenantCode) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showChange by remember { mutableStateOf(false) }

    fun afterLogin(data: LoginData) {
        Session.saveLogin(data)
        if (data.must_change_password) showChange = true else onLoggedIn()
    }

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
            OutlinedTextField(
                value = password, onValueChange = { password = it },
                label = { Text("密码") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
            )

            Button(
                onClick = {
                    error = null; loading = true
                    scope.launch {
                        Repo.login(phone.trim(), password, tenantCode.trim())
                            .onSuccess { loading = false; afterLogin(it) }
                            .onFailure { loading = false; error = it.message }
                    }
                },
                modifier = Modifier.fillMaxWidth(), enabled = !loading,
            ) {
                if (loading) CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp))
                Text("登录")
            }

            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }

            Text(
                "登录账号与初始密码由贵公司管理员统一发放；未授权手机号无法登录。",
                fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f),
                modifier = Modifier.padding(top = 16.dp)
            )
        }
    }

    if (showChange) {
        ChangePasswordDialog(
            initialPassword = password,
            onDismiss = { showChange = false; onLoggedIn() },
            onChanged = { showChange = false; onLoggedIn() },
        )
    }
}

/**
 * 首次登录提示改密：员工可自行决定。
 * - 「保存」：提交新密码，立即生效
 * - 「以后再说」：保留管理员下发的初始密码，只在服务端关掉提醒
 */
@Composable
fun ChangePasswordDialog(
    initialPassword: String,
    onDismiss: () -> Unit,
    onChanged: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var old by remember { mutableStateOf(initialPassword) }
    var new by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("是否修改初始密码？") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "当前使用的是管理员下发的初始密码。建议改成只有本人知道的密码；也可以先保留，之后在「我的」页随时修改。",
                    fontSize = 13.sp,
                )
                OutlinedTextField(
                    value = old, onValueChange = { old = it },
                    label = { Text("当前密码（初始密码）") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(),
                )
                OutlinedTextField(
                    value = new, onValueChange = { new = it },
                    label = { Text("新密码（至少 6 位）") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(),
                )
                OutlinedTextField(
                    value = confirm, onValueChange = { confirm = it },
                    label = { Text("确认新密码") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    if (new.length < 6) { error = "新密码至少 6 位"; return@TextButton }
                    if (new != confirm) { error = "两次输入的新密码不一致"; return@TextButton }
                    error = null; busy = true
                    scope.launch {
                        Repo.changePassword(old, new)
                            .onSuccess { Session.mustChangePassword = false; busy = false; onChanged() }
                            .onFailure { busy = false; error = it.message }
                    }
                },
            ) { if (busy) CircularProgressIndicator(modifier = Modifier.padding(end = 6.dp)) else Text("保存") }
        },
        dismissButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    busy = true
                    scope.launch {
                        Repo.keepInitialPassword()
                            .onSuccess { Session.mustChangePassword = false }
                            .onFailure { /* 保留初始密码失败也不影响使用，下次再提示 */ }
                        busy = false; onDismiss()
                    }
                },
            ) { Text("以后再说") }
        },
    )
}
