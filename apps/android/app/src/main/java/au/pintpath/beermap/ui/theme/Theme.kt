package au.pintpath.beermap.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Amber = Color(0xFFF78529)
val Honey = Color(0xFFFFC44D)
val Ink = Color(0xFF121820)
val Sky = Color(0xFF2E9EE0)
val Leaf = Color(0xFF298C59)
val Plum = Color(0xFF6B45B3)

private val LightScheme = lightColorScheme(
    primary = Amber,
    onPrimary = Color.White,
    secondary = Sky,
    tertiary = Leaf,
    background = Color(0xFFFFFBF7),
    surface = Color(0xFFFFFFFF),
    surfaceVariant = Color(0xFFF4EEE8),
    onSurface = Ink
)

private val DarkScheme = darkColorScheme(
    primary = Honey,
    onPrimary = Ink,
    secondary = Sky,
    tertiary = Leaf,
    background = Color(0xFF0E1117),
    surface = Color(0xFF171C24),
    surfaceVariant = Color(0xFF222A34),
    onSurface = Color(0xFFF7F3ED)
)

@Composable
fun BeerMapTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (androidx.compose.foundation.isSystemInDarkTheme()) DarkScheme else LightScheme,
        typography = androidx.compose.material3.Typography(),
        content = content
    )
}

