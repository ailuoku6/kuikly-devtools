pluginManagement {
    repositories {
        maven { url = uri("https://mirrors.tencent.com/nexus/repository/gradle-plugins/") }
        maven { url = uri("https://mirrors.tencent.com/nexus/repository/maven-public/") }
        gradlePluginPortal()
    }
}

rootProject.name = "kuikly-devtools-instrumentor"
