import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val releaseSigningVariableNames = listOf(
    "PINT_PATH_ANDROID_KEYSTORE_PATH",
    "PINT_PATH_ANDROID_KEYSTORE_PASSWORD",
    "PINT_PATH_ANDROID_KEY_ALIAS",
    "PINT_PATH_ANDROID_KEY_PASSWORD",
)
val releaseSigningEnvironment = releaseSigningVariableNames.associateWith { System.getenv(it) }
val configuredReleaseSigningVariables = releaseSigningVariableNames.filter {
    !releaseSigningEnvironment[it].isNullOrEmpty()
}

if (configuredReleaseSigningVariables.isNotEmpty()
    && configuredReleaseSigningVariables.size != releaseSigningVariableNames.size
) {
    val missingVariables = releaseSigningVariableNames - configuredReleaseSigningVariables.toSet()
    throw GradleException(
        "Android release signing is only partially configured. Set all four environment variables; missing: " +
            missingVariables.joinToString(", "),
    )
}

val releaseSigningConfigured = configuredReleaseSigningVariables.size == releaseSigningVariableNames.size
val androidAppProjectPath = project.path
val repositoryRoot = generateSequence(rootProject.projectDir.canonicalFile) { it.parentFile }
    .firstOrNull { file(it).resolve(".git").exists() }

android {
    namespace = "au.pintpath.beermap"
    compileSdk = 35

    fun String.toBuildConfigString(): String =
        "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    defaultConfig {
        applicationId = "au.pintpath.beermap"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.0.0"

        val apiBaseUrl = (project.findProperty("PINT_PATH_API_BASE_URL") as String?) ?: "https://pintpath.au"
        val supabaseUrl = (project.findProperty("SUPABASE_URL") as String?) ?: ""
        val supabaseAnonKey = (project.findProperty("SUPABASE_ANON_KEY") as String?) ?: ""

        buildConfigField("String", "PINT_PATH_API_BASE_URL", apiBaseUrl.toBuildConfigString())
        buildConfigField("String", "SUPABASE_URL", supabaseUrl.toBuildConfigString())
        buildConfigField("String", "SUPABASE_ANON_KEY", supabaseAnonKey.toBuildConfigString())
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                val configuredStorePath = releaseSigningEnvironment.getValue(
                    "PINT_PATH_ANDROID_KEYSTORE_PATH",
                )!!
                val unresolvedStoreFile = File(configuredStorePath)
                if (!unresolvedStoreFile.isAbsolute) {
                    throw GradleException(
                        "PINT_PATH_ANDROID_KEYSTORE_PATH must be an absolute path.",
                    )
                }
                val configuredStoreFile = unresolvedStoreFile.canonicalFile
                if (repositoryRoot != null
                    && configuredStoreFile.toPath().startsWith(repositoryRoot.toPath())
                ) {
                    throw GradleException(
                        "PINT_PATH_ANDROID_KEYSTORE_PATH must point outside the repository checkout.",
                    )
                }
                if (!configuredStoreFile.isFile) {
                    throw GradleException(
                        "PINT_PATH_ANDROID_KEYSTORE_PATH must point to an existing keystore file.",
                    )
                }
                storeFile = configuredStoreFile
                storePassword = releaseSigningEnvironment.getValue("PINT_PATH_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = releaseSigningEnvironment.getValue("PINT_PATH_ANDROID_KEY_ALIAS")
                keyPassword = releaseSigningEnvironment.getValue("PINT_PATH_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

gradle.taskGraph.whenReady {
    val releaseBundleRequested = allTasks.any {
        it.project.path == androidAppProjectPath && it.name == "bundleRelease"
    }
    if (releaseBundleRequested && !releaseSigningConfigured) {
        throw GradleException(
            "bundleRelease requires PINT_PATH_ANDROID_KEYSTORE_PATH, " +
                "PINT_PATH_ANDROID_KEYSTORE_PASSWORD, PINT_PATH_ANDROID_KEY_ALIAS, and " +
                "PINT_PATH_ANDROID_KEY_PASSWORD. Keep the keystore and values outside the repository.",
        )
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.10.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
