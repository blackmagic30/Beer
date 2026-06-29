package au.pintpath.beermap

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import au.pintpath.beermap.ui.features.BeerMapApp
import au.pintpath.beermap.ui.theme.BeerMapTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            BeerMapTheme {
                BeerMapApp()
            }
        }
    }
}

