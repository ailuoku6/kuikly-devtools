package com.ailuoku6.kuikly.devtools.instrumentor

// kotlin-compiler-embeddable relocates the IntelliJ platform under org.jetbrains.kotlin.
import org.jetbrains.kotlin.com.intellij.openapi.Disposable
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer
import org.jetbrains.kotlin.com.intellij.psi.PsiFileFactory
import org.jetbrains.kotlin.cli.common.CLIConfigurationKeys
import org.jetbrains.kotlin.cli.common.messages.MessageCollector
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment
import org.jetbrains.kotlin.config.CommonConfigurationKeys
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.idea.KotlinLanguage
import org.jetbrains.kotlin.psi.KtFile

/**
 * A parse-only Kotlin frontend.
 *
 * Only the parser is used, never the compiler, which is why the embedded Kotlin version here is
 * completely independent of the version the host project builds with. That is the whole reason this
 * approach survives both the 1.7.20 mobile pipeline and the 1.9.23-dev HarmonyOS one.
 */
class PsiEnvironment : AutoCloseable {

    private val disposable: Disposable = Disposer.newDisposable("kuikly-devtools-instrumentor")

    private val factory: PsiFileFactory = run {
        val configuration = CompilerConfiguration().apply {
            put(CommonConfigurationKeys.MODULE_NAME, "kuikly-devtools-instrumentor")
            put(CLIConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.NONE)
        }
        val environment = KotlinCoreEnvironment.createForProduction(
            disposable,
            configuration,
            EnvironmentConfigFiles.JVM_CONFIG_FILES
        )
        PsiFileFactory.getInstance(environment.project)
    }

    fun parse(fileName: String, text: String): KtFile =
        factory.createFileFromText(fileName, KotlinLanguage.INSTANCE, text) as KtFile

    override fun close() {
        Disposer.dispose(disposable)
    }
}
