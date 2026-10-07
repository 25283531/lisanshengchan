package com.molding.mes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.molding.mes.ui.theme.Brand
import com.molding.mes.ui.theme.Err
import com.molding.mes.ui.theme.Ok
import com.molding.mes.ui.theme.Warn

@Composable
fun SectionTitle(text: String, extra: String? = null) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        extra?.let {
            Text(
                it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f),
                modifier = Modifier.padding(start = 8.dp)
            )
        }
    }
}

@Composable
fun StatCard(label: String, value: String, hint: String? = null) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))
            Text(value, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            hint?.let { Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f)) }
        }
    }
}

@Composable
fun Tag(text: String, color: Color = Brand) {
    Box(
        Modifier
            .border(1.dp, color.copy(alpha = .4f), RoundedCornerShape(20.dp))
            .background(color.copy(alpha = .12f), RoundedCornerShape(20.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp)
    ) {
        Text(text, fontSize = 11.sp, color = color)
    }
}

fun levelColor(level: String?): Color = when (level) {
    "ERROR" -> Err
    "WARN" -> Warn
    "OK" -> Ok
    else -> Brand
}

@Composable
fun LoadingBox(text: String = "加载中…") {
    Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
        Text(text, modifier = Modifier.padding(top = 56.dp), fontSize = 12.sp)
    }
}

@Composable
fun EmptyBox(text: String) {
    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .5f))
    }
}

@Composable
fun ErrorBox(message: String, onRetry: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxWidth().padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(message, color = Err, fontSize = 13.sp)
        onRetry?.let { androidx.compose.material3.TextButton(onClick = it) { Text("重试") } }
    }
}
