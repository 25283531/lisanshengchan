package com.molding.mes.worker

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.molding.mes.data.Repo
import com.molding.mes.data.Session
import com.molding.mes.notify.Notifier
import java.util.concurrent.TimeUnit

/**
 * 消息轮询。
 * 车间现场通常没有可用的境外推送通道，采用「轮询 + 本地通知」最稳；
 * 若后续接入 FCM / 厂商推送，只需把这里的拉取逻辑换成推送回调即可。
 */
class PollWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (!Session.isLoggedIn) return Result.success()
        return try {
            val list = Repo.notifications(limit = 20).getOrNull() ?: return Result.success()
            val fresh = list.filter { !it.is_read }
            if (fresh.isNotEmpty()) {
                Notifier.show(applicationContext, fresh)
            }
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val NAME = "mes_poll"

        fun enable(context: Context, intervalMinutes: Long = 15) {
            val req = PeriodicWorkRequestBuilder<PollWorker>(intervalMinutes, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                NAME, ExistingPeriodicWorkPolicy.UPDATE, req
            )
        }

        fun disable(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
