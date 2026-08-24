plugins {
    kotlin("jvm") version "1.9.24"
}

group = "com.ailuoku6.kuikly.devtools"
version = "0.1.0"

repositories {
    maven { url = uri("https://mirrors.tencent.com/nexus/repository/maven-public/") }
    maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") }
    mavenCentral()
}

dependencies {
    // Only used to *parse* Kotlin into PSI. The instrumentor never compiles anything, so this
    // version is independent of the Kotlin version the host project builds with (1.7.20 here,
    // 1.9.23-dev-218 for the HarmonyOS pipeline).
    implementation("org.jetbrains.kotlin:kotlin-compiler-embeddable:1.9.24")
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}

/** Fat jar so the Gradle init script can put a single file on the classpath. */
val fatJar by tasks.registering(Jar::class) {
    dependsOn(tasks.classes)
    archiveFileName.set("kuikly-devtools-instrumentor.jar")
    destinationDirectory.set(file("$rootDir/../gradle/libs"))
    manifest {
        attributes["Main-Class"] = "com.ailuoku6.kuikly.devtools.instrumentor.MainKt"
    }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(sourceSets.main.get().output)
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) }) {
        exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "META-INF/versions/9/module-info.class")
    }
}

tasks.build {
    dependsOn(fatJar)
}
