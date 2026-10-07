package com.molding.mes

import android.app.Application
import com.molding.mes.data.Session
import com.molding.mes.notify.Notifier
import com.molding.mes.worker.PollWorker

class MesApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Session.init(this)
        Notifier.createChannels(this)
        if (Session.isLoggedIn) PollWorker.enable(this)
    }
}
