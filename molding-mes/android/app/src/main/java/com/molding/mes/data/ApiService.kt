package com.molding.mes.data

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

interface ApiService {

    @POST("api/auth/login")
    suspend fun login(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiResp<LoginData>

    @GET("api/auth/me")
    suspend fun me(): ApiResp<MeData>

    @POST("api/auth/password")
    suspend fun changePassword(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiResp<Map<String, Any?>>

    /** 暂不修改：保留管理员下发的初始密码，只关闭本次提醒 */
    @POST("api/auth/password/later")
    suspend fun keepInitialPassword(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiResp<Map<String, Any?>>

    @GET("api/notifications")
    suspend fun notifications(
        @Query("limit") limit: Int = 50,
        @Query("unread") unread: Int? = null,
        @Query("type") type: String? = null,
    ): ApiResp<List<NotificationItem>>

    @GET("api/notifications/unread-count")
    suspend fun unreadCount(): ApiResp<UnreadData>

    @POST("api/notifications/{id}/read")
    suspend fun markRead(@Path("id") id: Long): ApiResp<Unit>

    @POST("api/notifications/read-all")
    suspend fun markAllRead(): ApiResp<Map<String, Any?>>

    @POST("api/chat")
    suspend fun chat(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiResp<ChatResult>

    @POST("api/chat/parse")
    suspend fun chatParse(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiResp<ChatResult>

    @GET("api/schedule/tasks")
    suspend fun tasks(): ApiResp<List<ScheduleTask>>

    @GET("api/schedule/shift")
    suspend fun shift(@Query("hours") hours: Int = 12, @Query("start") start: String? = null): ApiResp<ShiftData>

    @GET("api/schedule/materials")
    suspend fun materials(): ApiResp<MaterialData>

    @GET("api/orders")
    suspend fun orders(@Query("status") status: String? = null): ApiResp<List<OrderItem>>

    /** 提交新订单（业务员 / 老板 / PMC / 管理员） */
    @POST("api/orders")
    suspend fun createOrder(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiResp<OrderCreateResult>

    /** 修改订单（数量 / 交期 / 备注） */
    @PUT("api/orders/{id}")
    suspend fun updateOrder(
        @Path("id") id: Long,
        @Body body: Map<String, @JvmSuppressWildcards Any?>,
    ): ApiResp<Map<String, Any?>>

    /* --------------------------- 设备维修保养 --------------------------- */

    @GET("api/maintenance/overview")
    suspend fun maintenanceOverview(): ApiResp<MaintenanceOverview>

    @GET("api/maintenance/plans")
    suspend fun maintenancePlans(
        @Query("status") status: String? = null,
        @Query("mine") mine: Int? = null,
    ): ApiResp<List<MaintenancePlan>>

    @POST("api/maintenance/plans")
    suspend fun createMaintenancePlan(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiResp<Map<String, Any?>>

    @POST("api/maintenance/plans/{id}/status")
    suspend fun maintenancePlanStatus(
        @Path("id") id: Long,
        @Body body: Map<String, @JvmSuppressWildcards Any?>,
    ): ApiResp<Map<String, Any?>>

    @GET("api/maintenance/devices")
    suspend fun maintenanceDevices(): ApiResp<DeviceListData>

    @POST("api/orders/{id}/outbound")
    suspend fun outbound(
        @Path("id") id: Long,
        @Body body: Map<String, @JvmSuppressWildcards Any?>,
    ): ApiResp<Map<String, Any?>>

    @POST("api/orders/{id}/progress")
    suspend fun progress(
        @Path("id") id: Long,
        @Body body: Map<String, @JvmSuppressWildcards Any?>,
    ): ApiResp<Map<String, Any?>>

    @GET("api/master")
    suspend fun master(): ApiResp<MasterData>
}
