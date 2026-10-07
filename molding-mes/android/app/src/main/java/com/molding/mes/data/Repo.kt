package com.molding.mes.data

/**
 * 仓库层：统一把接口响应转成 Result，UI 只处理成功/失败两种结果。
 */
object Repo {

    private suspend fun <T> call(block: suspend () -> ApiResp<T>): Result<T> = runCatching {
        val resp = block()
        if (resp.isOk && resp.data != null) resp.data!!
        else throw IllegalStateException(resp.message ?: "请求失败")
    }

    private suspend fun unit(block: suspend () -> ApiResp<*>): Result<Unit> = runCatching {
        val resp = block()
        if (!resp.isOk) throw IllegalStateException(resp.message ?: "请求失败")
    }

    suspend fun login(phone: String, password: String, tenantCode: String): Result<LoginData> =
        call { Session.api.login(mapOf("phone" to phone, "password" to password, "tenantCode" to tenantCode)) }

    suspend fun sendSms(phone: String, tenantCode: String): Result<Map<String, Any?>> =
        call { Session.api.sendSms(mapOf("phone" to phone, "tenantCode" to tenantCode)) }

    suspend fun loginSms(phone: String, code: String, tenantCode: String): Result<LoginData> =
        call { Session.api.loginSms(mapOf("phone" to phone, "code" to code, "tenantCode" to tenantCode)) }

    suspend fun me(): Result<MeData> = call { Session.api.me() }

    suspend fun notifications(limit: Int = 50, unreadOnly: Boolean = false, type: String? = null): Result<List<NotificationItem>> =
        call { Session.api.notifications(limit, if (unreadOnly) 1 else null, type) }

    suspend fun unreadCount(): Result<Int> = runCatching { Session.api.unreadCount().data?.unread ?: 0 }

    suspend fun markRead(id: Long): Result<Unit> = unit { Session.api.markRead(id) }

    suspend fun markAllRead(): Result<Unit> = unit { Session.api.markAllRead() }

    /** 一句话办事：下单 / 出库 / 报工 / 查库存 */
    suspend fun chat(text: String): Result<ChatResult> = call { Session.api.chat(mapOf("text" to text)) }

    suspend fun tasks(): Result<List<ScheduleTask>> = call { Session.api.tasks() }

    suspend fun shift(hours: Int = 12): Result<ShiftData> = call { Session.api.shift(hours) }

    suspend fun materials(): Result<MaterialData> = call { Session.api.materials() }

    suspend fun orders(): Result<List<OrderItem>> = call { Session.api.orders() }

    suspend fun outbound(orderId: Long, qty: Int): Result<Map<String, Any?>> =
        call { Session.api.outbound(orderId, mapOf("qty" to qty, "source" to "APP")) }

    suspend fun progress(orderId: Long, qty: Int): Result<Map<String, Any?>> =
        call { Session.api.progress(orderId, mapOf("qty" to qty)) }

    suspend fun master(): Result<MasterData> = call { Session.api.master() }
}
