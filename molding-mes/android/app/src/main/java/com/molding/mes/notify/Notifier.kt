package com.molding.mes.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.molding.mes.R
import com.molding.mes.data.NotificationItem

object Notifier {

    private const val CH_MAIN = "mes_main"
    private const val CH_ALERT = "mes_alert"

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        listOf(
            NotificationChannel(CH_MAIN, "生产任务", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CH_ALERT, "告警提醒", NotificationManager.IMPORTANCE_HIGH),
        ).forEach { nm.createNotificationChannel(it) }
    }

    private fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun show(context: Context, items: List<NotificationItem>) {
        if (!canPost(context)) return
        createChannels(context)
        // 单条弹最新，多条折叠成摘要，避免刷屏
        if (items.size == 1) {
            notifyOne(context, items.first())
        } else {
            val inbox = NotificationCompat.InboxStyle()
            items.take(6).forEach { inbox.addLine("${it.title}") }
            inbox.setSummaryText("共 ${items.size} 条未读")
            val n = NotificationCompat.Builder(context, CH_MAIN)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle("${items.size} 条新消息")
                .setContentText(items.first().title)
                .setStyle(inbox)
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(context).notify(2000, n)
        }
    }

    private fun notifyOne(context: Context, item: NotificationItem) {
        val alert = item.level == "ERROR" || item.level == "WARN"
        val n = NotificationCompat.Builder(context, if (alert) CH_ALERT else CH_MAIN)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(item.title)
            .setContentText(item.body ?: "")
            .setStyle(NotificationCompat.BigTextStyle().bigText(item.body ?: ""))
            .setPriority(if (alert) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(item.id.toInt(), n)
    }
}
