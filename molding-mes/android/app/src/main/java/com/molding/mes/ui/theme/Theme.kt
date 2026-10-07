package com.molding.mes.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Brand = Color(0xFF0D7A6F)
val BrandDark = Color(0xFF0A5F57)
val Ink = Color(0xFF1C2B2E)
val Warn = Color(0xFFB26A00)
val Err = Color(0xFFC0392B)
val Ok = Color(0xFF1F8B4C)

private val LightColors = lightColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD5ECE9),
    secondary = BrandDark,
    background = Color(0xFFF5F7F8),
    surface = Color.White,
    error = Err,
    onBackground = Ink,
    onSurface = Ink,
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF4DBFAE),
    onPrimary = Color(0xFF05201D),
    secondary = Color(0xFF3AA294),
    background = Color(0xFF0F1618),
    surface = Color(0xFF151F22),
    error = Color(0xFFE4796B),
)

@Composable
fun MoldingMesTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography(),
        content = content,
    )
}
