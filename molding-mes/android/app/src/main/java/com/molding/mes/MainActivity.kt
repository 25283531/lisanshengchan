package com.molding.mes

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.molding.mes.data.Session
import com.molding.mes.ui.AssistantScreen
import com.molding.mes.ui.HomeScreen
import com.molding.mes.ui.LoginScreen
import com.molding.mes.ui.MeScreen
import com.molding.mes.ui.ScheduleScreen
import com.molding.mes.ui.theme.MoldingMesTheme
import com.molding.mes.worker.PollWorker

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { MoldingMesTheme { AppNav() } }
    }
}

private enum class Tab(val title: String, val icon: ImageVector) {
    HOME("首页", Icons.Filled.Home),
    ASSISTANT("助手", Icons.Filled.PlayArrow),
    SCHEDULE("排产", Icons.Filled.Refresh),
    ME("我的", Icons.Filled.Person),
}

@Composable
private fun AppNav() {
    val nav = rememberNavController()
    val start = if (Session.isLoggedIn) "main" else "login"

    NavHost(navController = nav, startDestination = start) {
        composable("login") {
            LoginScreen {
                PollWorker.enable(nav.context)
                nav.navigate("main") { popUpTo("login") { inclusive = true } }
            }
        }
        composable("main") { MainScaffold(onLogout = { nav.navigate("login") { popUpTo("main") { inclusive = true } } }) }
    }
}

@Composable
private fun MainScaffold(onLogout: () -> Unit) {
    var tab by remember { mutableStateOf(Tab.HOME) }

    // Android 13+ 需要显式申请通知权限，否则收不到推送
    val context = androidx.compose.ui.platform.LocalContext.current
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            permLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Scaffold(
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                Tab.values().forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(t.icon, contentDescription = t.title) },
                        label = { Text(t.title) },
                    )
                }
            }
        },
    ) { padding ->
        androidx.compose.foundation.layout.Column(Modifier.padding(padding)) {
            when (tab) {
                Tab.HOME -> HomeScreen(onOpenAssistant = { tab = Tab.ASSISTANT })
                Tab.ASSISTANT -> AssistantScreen()
                Tab.SCHEDULE -> ScheduleScreen()
                Tab.ME -> MeScreen(onLogout)
            }
        }
    }
}
