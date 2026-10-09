package com.molding.mes.data

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.TypeAdapter
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import com.google.gson.stream.JsonWriter
import com.molding.mes.BuildConfig
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * 会话与网络客户端。
 * 服务端地址可在「我的」页面修改（车间内网部署时常用），默认走模拟器访问宿主机。
 */
object Session {

    private const val PREF = "mes_session"
    private const val K_TOKEN = "token"
    private const val K_BASE = "base_url"
    private const val K_TENANT = "tenant_code"
    private const val K_NAME = "name"
    private const val K_ROLE = "role"
    private const val K_ROLE_ZH = "role_zh"
    private const val K_MACHINE = "machine_code"
    private const val K_PHONE = "phone"
    private const val K_MUST_CHANGE = "must_change_password"
    private const val K_PERMS = "permissions"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
    }

    var token: String?
        get() = prefs.getString(K_TOKEN, null)
        set(v) = prefs.edit().putString(K_TOKEN, v).apply()

    var baseUrl: String
        get() = prefs.getString(K_BASE, null) ?: BuildConfig.DEFAULT_BASE_URL
        set(v) = prefs.edit().putString(K_BASE, normalize(v)).apply()

    var tenantCode: String
        get() = prefs.getString(K_TENANT, null) ?: BuildConfig.DEFAULT_TENANT_CODE
        set(v) = prefs.edit().putString(K_TENANT, v).apply()

    var userName: String
        get() = prefs.getString(K_NAME, "") ?: ""
        set(v) = prefs.edit().putString(K_NAME, v).apply()

    var role: String
        get() = prefs.getString(K_ROLE, "") ?: ""
        set(v) = prefs.edit().putString(K_ROLE, v).apply()

    var roleZh: String
        get() = prefs.getString(K_ROLE_ZH, "") ?: ""
        set(v) = prefs.edit().putString(K_ROLE_ZH, v).apply()

    /** 生产人员绑定的机台；为空表示接收全部机台消息 */
    var machineCode: String?
        get() = prefs.getString(K_MACHINE, null)
        set(v) = prefs.edit().putString(K_MACHINE, v).apply()

    var phone: String
        get() = prefs.getString(K_PHONE, "") ?: ""
        set(v) = prefs.edit().putString(K_PHONE, v).apply()

    /** 是否仍在使用管理员下发的初始密码 */
    var mustChangePassword: Boolean
        get() = prefs.getBoolean(K_MUST_CHANGE, false)
        set(v) = prefs.edit().putBoolean(K_MUST_CHANGE, v).apply()

    /** 服务端下发的权限点，UI 据此决定"能不能提交"，避免无权操作后才发现报错 */
    var permissions: Set<String>
        get() = (prefs.getString(K_PERMS, "") ?: "").split(",").filter { it.isNotBlank() }.toSet()
        set(v) = prefs.edit().putString(K_PERMS, v.joinToString(",")).apply()

    fun can(permission: String): Boolean = permissions.contains(permission)

    val isLoggedIn: Boolean get() = !token.isNullOrBlank()

    fun saveLogin(data: LoginData) {
        token = data.token
        userName = data.user.name
        role = data.user.role
        roleZh = data.user.role_zh ?: data.user.role
        machineCode = data.user.machine_code
        phone = data.user.phone
        tenantCode = data.tenant.code
        mustChangePassword = data.must_change_password
        permissions = data.user.permissions.toSet()
    }

    fun clear() = prefs.edit().clear().apply()

    private fun normalize(url: String): String {
        var u = url.trim()
        if (!u.endsWith("/")) u = "$u/"
        if (!u.startsWith("http")) u = "http://$u"
        return u
    }

    private val authInterceptor = Interceptor { chain ->
        val req = chain.request().newBuilder().apply {
            token?.let { addHeader("Authorization", "Bearer $it") }
            addHeader("Accept", "application/json")
        }.build()
        chain.proceed(req)
    }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(authInterceptor)
            .apply {
                if (BuildConfig.DEBUG) {
                    addInterceptor(HttpLoggingInterceptor().setLevel(HttpLoggingInterceptor.Level.BASIC))
                }
            }
            .build()
    }

    val api: ApiService get() = Retrofit.Builder()
        .baseUrl(baseUrl)
        .client(client)
        .addConverterFactory(GsonConverterFactory.create(gson))
        .build()
        .create(ApiService::class.java)

    /**
     * Gson 对 JsonObject 字段遇到 JSON null 时会把 JsonNull.INSTANCE 塞进字段，
     * 后续当成 JsonObject 使用就抛 "Expected a JsonObject but was JsonNull"。
     * 助手响应里的 data/parsed 经常为 null（候选确认、纯查询场景），这里统一在
     * 解析层把 null 转成 Kotlin null，UI 侧的可空处理才能正常生效。
     */
    private val gson by lazy {
        GsonBuilder()
            .registerTypeAdapter(JsonObject::class.java, object : TypeAdapter<JsonObject>() {
                override fun read(reader: JsonReader): JsonObject? {
                    if (reader.peek() == JsonToken.NULL) {
                        reader.nextNull()
                        return null
                    }
                    return JsonParser.parseReader(reader).asJsonObject
                }

                override fun write(out: JsonWriter, value: JsonObject?) {
                    if (value == null) out.nullValue() else out.jsonValue(value.toString())
                }
            })
            .create()
    }
}
