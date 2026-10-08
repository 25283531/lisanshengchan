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
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
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
import androidx.compose.ui.res.painterResource
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.molding.mes.R
import com.molding.mes.data.Session
import com.molding.mes.ui.AssistantScreen
import com.molding.mes.ui.HomeScreen
import com.molding.mes.ui.LoginScreen
import com.molding.mes.ui.MaintenanceScreen
import com.molding.mes.ui.MeScreen
import com.molding.mes.ui.OrdersScreen
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

private enum class Tab(val title: String, val icon: ImageVector?, val iconRes: Int?) {
    HOME("首页", Icons.Filled.Home, null),
    ASSISTANT("助手", Icons.Filled.PlayArrow, null),
    // Refresh 属于 material-icons-extended，本项目只依赖 core，改用本地矢量图标
    SCHEDULE("排产", null, R.drawable.ic_nav_schedule),
    ORDERS("订单", Icons.Filled.List, null),
    MAINTENANCE("设备", Icons.Filled.Build, null),
    ME("我的", Icons.Filled.Person, null),
}

/**
 * 底部导航按角色定制中间那个"业务"入口：
 * 技术员最常去设备页，其余角色最常看订单；两个页面在首页都有入口，不受底部限制。
 */
private fun tabsForRole(): List<Tab> {
    val business = if (Session.role == "TECHNICIAN") Tab.MAINTENANCE else Tab.ORDERS
    return listOf(Tab.HOME, Tab.ASSISTANT, Tab.SCHEDULE, business, Tab.ME)
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

    val tabs = remember { tabsForRole() }

    Scaffold(
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                tabs.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = {
                            if (t.icon != null) Icon(t.icon!!, contentDescription = t.title)
                            else Icon(painterResource(t.iconRes!!), contentDescription = t.title)
                        },
                        label = { Text(t.title) },
                    )
                }
            }
        },
    ) { padding ->
        androidx.compose.foundation.layout.Column(Modifier.padding(padding)) {
            when (tab) {
                Tab.HOME -> HomeScreen(
                    onOpenAssistant = { tab = Tab.ASSISTANT },
                    onOpenOrders = { tab = Tab.ORDERS },
                    onOpenMaintenance = { tab = Tab.MAINTENANCE },
                )
                Tab.ASSISTANT -> AssistantScreen()
                Tab.SCHEDULE -> ScheduleScreen()
                Tab.ORDERS -> OrdersScreen()
                Tab.MAINTENANCE -> MaintenanceScreen()
                Tab.ME -> MeScreen(onLogout)
            }
        }
    }
}
