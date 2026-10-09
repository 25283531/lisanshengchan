package com.molding.mes.data

import com.google.gson.JsonElement
import com.google.gson.JsonObject

/** 统一响应外壳。code 可能是数字 0，也可能是字符串错误码，统一按字符串比对。 */
data class ApiResp<T>(
    val code: JsonElement? = null,
    val message: String? = null,
    val data: T? = null,
) {
    val isOk: Boolean get() = code?.asString == "0"
}

/* ------------------------------ 登录与身份 ------------------------------ */

data class LoginData(
    val token: String,
    val token_type: String? = null,
    val expires_in_hours: Int? = null,
    val user: UserInfo,
    val tenant: TenantInfo,
    /** 当前仍在使用管理员下发的初始密码：APP 提示员工自行决定是否修改 */
    val must_change_password: Boolean = false,
    val password_hint: String? = null,
)

data class UserInfo(
    val id: Long,
    val phone: String,
    val name: String,
    val role: String,
    val role_zh: String? = null,
    val machine_code: String? = null,
    val permissions: List<String> = emptyList(),
)

data class TenantInfo(
    val id: Long,
    val code: String,
    val name: String,
    val expires_at: String? = null,
    val max_users: Int? = null,
)

data class MeData(
    val id: Long,
    val name: String,
    val role: String,
    val role_zh: String? = null,
    val machine_code: String? = null,
    val permissions: List<String> = emptyList(),
    val tenant: TenantInfo? = null,
)

/* -------------------------------- 消息 --------------------------------- */

data class NotificationItem(
    val id: Long,
    val type: String,
    val title: String,
    val body: String? = null,
    val payload: JsonObject? = null,
    val level: String? = null,
    val machine_code: String? = null,
    val ref_type: String? = null,
    val ref_id: Long? = null,
    val created_at: String? = null,
    val is_read: Boolean = false,
)

data class UnreadData(val unread: Int = 0)

/* -------------------------------- 排产 --------------------------------- */

data class ScheduleTask(
    val id: Long? = null,
    val seq: Int = 0,
    val order_code: String? = null,
    val order_id: Long? = null,
    val product_name: String? = null,
    val machine_code: String? = null,
    val mold_code: String? = null,
    val decision: String? = null,
    val planned_qty: Int = 0,
    val start_at: String? = null,
    val end_at: String? = null,
    val feeding_order_at: String? = null,
    val feeding_ready_at: String? = null,
    val status: String? = null,
)

data class ShiftItem(
    val machine_code: String? = null,
    val product_name: String? = null,
    val product_sku: String? = null,
    val mold_code: String? = null,
    val planned_qty: Int = 0,
    val order_code: String? = null,
    val window_start: String? = null,
    val window_end: String? = null,
    val decision: String? = null,
)

data class ShiftData(
    val shift_start: String? = null,
    val hours: Int = 12,
    val items: List<ShiftItem> = emptyList(),
)

data class MaterialDetail(
    val order_code: String? = null,
    val qty: Double = 0.0,
    val use_at: String? = null,
    val mixer_code: String? = null,
    val machine_code: String? = null,
)

data class MaterialGroup(
    val kind: String = "MATERIAL",
    val sku: String = "",
    val name: String? = null,
    val unit: String = "kg",
    val total_qty: Double = 0.0,
    val details: List<MaterialDetail> = emptyList(),
)

data class MaterialData(
    val items: List<MaterialGroup> = emptyList(),
)

/* -------------------------------- 订单 --------------------------------- */

data class OrderItem(
    val id: Long,
    val code: String,
    val customer_name: String? = null,
    val product_name: String? = null,
    val quantity: Int = 0,
    val remaining_qty: Int = 0,
    val completed_qty: Int = 0,
    val due_date: String? = null,
    val status: String? = null,
)

/** 新建订单的返回：只回 id 与单号 */
data class OrderCreateResult(val id: Long = 0, val code: String = "")

/* ------------------------------ 设备维修保养 ---------------------------- */

data class DeviceItem(
    val code: String = "",
    val name: String? = null,
    val status: String? = null,
    val current_mold_code: String? = null,
)

data class MoldDueItem(
    val code: String = "",
    val name: String? = null,
    val cumulative_shots: Int = 0,
    val maintenance_at_shots: Int = 0,
    val remaining_shots: Int = 0,
    val overdue: Boolean = false,
)

data class MaintenanceCounts(
    val planned: Int = 0,
    val doing: Int = 0,
    val machine_fault: Int = 0,
    val mold_maintenance: Int = 0,
)

data class MaintenancePlan(
    val id: Long = 0,
    val code: String = "",
    val target_type: String = "MACHINE",
    val target_type_zh: String? = null,
    val target_code: String = "",
    val target_name: String? = null,
    val kind: String = "REPAIR",
    val kind_zh: String? = null,
    val fault_desc: String? = null,
    val plan_start_at: String? = null,
    val plan_finish_at: String? = null,
    val duration_minutes: Int = 0,
    val status: String = "PLANNED",
    val status_zh: String? = null,
    val result_note: String? = null,
    val finished_at: String? = null,
    val created_by_name: String? = null,
    val created_at: String? = null,
)

data class MaintenanceOverview(
    val machines: List<DeviceItem> = emptyList(),
    val molds: List<DeviceItem> = emptyList(),
    val mold_due: List<MoldDueItem> = emptyList(),
    val plans: List<MaintenancePlan> = emptyList(),
    val counts: MaintenanceCounts = MaintenanceCounts(),
    val open_count: Int = 0,
)

data class DeviceOption(val code: String = "", val name: String? = null, val status: String? = null)

data class DeviceListData(
    val machines: List<DeviceOption> = emptyList(),
    val molds: List<DeviceOption> = emptyList(),
)

/* ------------------------------ 自然语言 ------------------------------- */

data class ChatResult(
    val intent: String,
    val message: String? = null,
    val confidence: Double = 0.0,
    val used_fallback: Boolean = false,
    /** 走了本地降级解析（AI 不可用或调用失败） */
    val degraded: Boolean = false,
    /** AI 不可用且本地接不住：message 固定为提示文案 */
    val ai_unavailable: Boolean = false,
    val needs_confirm: Boolean = false,
    /**
     * 注意：这里**不能**用 JsonObject/JsonObject? —— Gson 2.11 起
     * JSON_ELEMENT 工厂对 JsonElement 子类型字段强校验运行时类型，
     * JSON null（JsonNull.INSTANCE）会直接抛
     * "Expected a JsonObject but was JsonNull"，且 registerTypeAdapter
     * 优先级低于该内置工厂、拦不住。改用 Map/Any?（走 ObjectTypeAdapter，
     * null → Kotlin null，无子类型校验），配合服务端 stripNulls 双保险。
     */
    val candidates: List<Map<String, Any?>> = emptyList(),
    val data: Any? = null,
    val parsed: Map<String, Any?>? = null,
    val error: String? = null,
)

/* -------------------------------- 主数据 ------------------------------- */

data class MasterData(
    val machines: List<JsonObject> = emptyList(),
    val molds: List<JsonObject> = emptyList(),
    val products: List<JsonObject> = emptyList(),
    val materials: List<JsonObject> = emptyList(),
    val labels: List<JsonObject> = emptyList(),
    val customers: List<JsonObject> = emptyList(),
)
