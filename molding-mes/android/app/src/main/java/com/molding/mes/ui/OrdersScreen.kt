package com.molding.mes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.rememberCoroutineScope
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
import com.molding.mes.data.OrderItem
import com.molding.mes.data.Repo
import com.molding.mes.data.Session

/**
 * 订单：所有人都能看，有权限的（业务员 / 老板 / PMC / 管理员）可以直接在手机上提交与修改。
 * 权限来自服务端下发的 permissions，不在客户端硬编码角色。
 */
@Composable
fun OrdersScreen() {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var orders by remember { mutableStateOf<List<OrderItem>>(emptyList()) }
    var products by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var editing by remember { mutableStateOf<OrderItem?>(null) }
    var reporting by remember { mutableStateOf<OrderItem?>(null) }
    var creating by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        loading = true; error = null
        runCatching {
            orders = Repo.orders().getOrDefault(emptyList())
            if (Session.can("order.create")) products = Repo.master().getOrNull()?.products ?: emptyList()
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
        SectionTitle("订单", "共 ${orders.size} 条")

        if (Session.can("order.create")) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { creating = true }, modifier = Modifier.weight(1f)) { Text("提交新订单") }
            }
        } else {
            Text("当前角色只能查看订单，提交与修改由业务员/管理员处理", fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))
        }

        toast?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary) }
        if (loading) LoadingBox()
        error?.let { ErrorBox(it) { } }

        if (orders.isEmpty() && !loading) EmptyBox("暂无订单")
        orders.forEach { o ->
            Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(o.product_name ?: "-", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                        Tag(o.status ?: "DRAFT")
                    }
                    Text("${o.code}${o.customer_name?.let { " · $it" } ?: ""}", fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = .7f))
                    Text("下单 ${o.quantity}　已完工 ${o.completed_qty}　待生产 ${o.remaining_qty}", fontSize = 12.sp)
                    Text("交期 ${o.due_date ?: "未定"}", fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = .7f))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (Session.can("order.update")) {
                            OutlinedButton(onClick = { editing = o }, modifier = Modifier.padding(top = 6.dp)) {
                                Text("修改数量 / 交期")
                            }
                        }
                        // 报工 = 提交当班产量：生产人员与仓库可用
                        if (Session.can("order.outbound")) {
                            OutlinedButton(onClick = { reporting = o }, modifier = Modifier.padding(top = 6.dp)) {
                                Text("报产量")
                            }
                        }
                    }
                }
            }
        }
    }

    if (creating) {
        OrderEditDialog(
            title = "提交新订单",
            products = products,
            initName = null,
            initQty = "",
            initDue = "",
            onDismiss = { creating = false },
            onSubmit = { productId, qty, due ->
                scope.launch {
                    val r = Repo.createOrder(productId, qty, due.ifBlank { null }, "APP 提交")
                    creating = false
                    toast = if (r.isSuccess) "已提交订单 ${r.getOrNull()?.code ?: ""}" else "提交失败：${r.exceptionOrNull()?.message}"
                    load()
                }
            },
        )
    }

    reporting?.let { o ->
        QtyDialog(
            title = "提交当班产量 · ${o.code}",
            label = "本次完工数量（待生产 ${o.remaining_qty}）",
            onDismiss = { reporting = null },
            onSubmit = { qty ->
                scope.launch {
                    val r = Repo.progress(o.id, qty)
                    reporting = null
                    toast = if (r.isSuccess) "已报工 $qty 个" else "报工失败：${r.exceptionOrNull()?.message}"
                    load()
                }
            },
        )
    }

    editing?.let { o ->
        OrderEditDialog(
            title = "修改订单 ${o.code}",
            products = products,
            initName = o.product_name,
            initQty = o.quantity.toString(),
            initDue = o.due_date ?: "",
            onDismiss = { editing = null },
            onSubmit = { _, qty, due ->
                scope.launch {
                    val r = Repo.updateOrder(o.id, quantity = qty, dueDate = due.ifBlank { null })
                    editing = null
                    toast = if (r.isSuccess) "订单已更新" else "修改失败：${r.exceptionOrNull()?.message}"
                    load()
                }
            },
        )
    }
}

/**
 * 新建/修改订单表单。
 * 产品从主数据里选（避免手输编码打错），数量与交期必填项由服务端兜底校验。
 */
@Composable
private fun OrderEditDialog(
    title: String,
    products: List<JsonObject>,
    initName: String?,
    initQty: String,
    initDue: String,
    onDismiss: () -> Unit,
    onSubmit: (productId: Long, qty: Int, due: String) -> Unit,
) {
    val names = products.map { it.get("name")?.asString ?: it.get("sku")?.asString ?: "-" }
    var productName by remember { mutableStateOf(initName ?: names.firstOrNull() ?: "") }
    var qty by remember { mutableStateOf(initQty) }
    var due by remember { mutableStateOf(initDue) }
    var err by remember { mutableStateOf<String?>(null) }

    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (products.isEmpty()) {
                    Text("尚未建档产品，请先让管理员在后台录入", fontSize = 12.sp)
                } else {
                    ProductDropdown(names, productName) { productName = it }
                }
                OutlinedTextField(
                    value = qty, onValueChange = { qty = it.filter { c -> c.isDigit() } },
                    label = { Text("数量") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = due, onValueChange = { due = it },
                    label = { Text("交期 YYYY-MM-DD（可留空）") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                err?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
            }
        },
        confirmButton = {
            Button(onClick = {
                val id = products.firstOrNull {
                    (it.get("name")?.asString ?: it.get("sku")?.asString) == productName
                }?.get("id")?.asLong
                val q = qty.toIntOrNull()
                when {
                    id == null -> err = "请选择产品"
                    q == null || q <= 0 -> err = "数量必须大于 0"
                    else -> onSubmit(id, q, due.trim())
                }
            }) { Text("提交") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("取消") } },
    )
}

/** 只填数字的对话框：报工、出库这类"提交一个数"的场景 */
@Composable
private fun QtyDialog(title: String, label: String, onDismiss: () -> Unit, onSubmit: (Int) -> Unit) {
    var qty by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, fontSize = 16.sp) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = qty, onValueChange = { qty = it.filter { c -> c.isDigit() } },
                    label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                err?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
            }
        },
        confirmButton = {
            Button(onClick = {
                val q = qty.toIntOrNull()
                if (q == null || q <= 0) err = "数量必须大于 0" else onSubmit(q)
            }) { Text("提交") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("取消") } },
    )
}

/** 产品下拉：从主数据里选，避免手输编码打错 */
@Composable
private fun ProductDropdown(items: List<String>, selected: String, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
            Text(if (selected.isBlank()) "点击选择产品" else selected)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            items.forEach { n ->
                DropdownMenuItem(text = { Text(n) }, onClick = { onSelect(n); expanded = false })
            }
        }
    }
}
