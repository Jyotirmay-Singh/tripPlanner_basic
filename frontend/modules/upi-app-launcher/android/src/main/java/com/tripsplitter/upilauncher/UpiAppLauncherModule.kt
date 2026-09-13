package com.tripsplitter.upilauncher

import android.content.ActivityNotFoundException
import android.content.Intent
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private val UPI_APP_PACKAGES = linkedMapOf(
  "google-pay" to "com.google.android.apps.nbu.paisa.user",
  "phonepe" to "com.phonepe.app",
  "paytm" to "net.one97.paytm",
  "bhim" to "in.org.npci.upiapp"
)

internal class UpiLauncherContextUnavailableException :
  CodedException("Android application context is unavailable", null)

internal class InvalidUpiAppException :
  CodedException("Unsupported UPI app identifier", null)

internal class UpiAppUnavailableException :
  CodedException("The selected UPI app is not installed or has no launcher activity", null)

internal class UpiAppLaunchException(cause: Throwable) :
  CodedException("The selected UPI app could not be opened", cause)

class UpiAppLauncherModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("UpiAppLauncher")

    AsyncFunction("getAvailableUpiApps") {
      val context = appContext.reactContext ?: throw UpiLauncherContextUnavailableException()
      UPI_APP_PACKAGES.filterValues { packageName ->
        context.packageManager.getLaunchIntentForPackage(packageName) != null
      }.keys.toList()
    }

    AsyncFunction("launchUpiApp") { appId: String ->
      val packageName = UPI_APP_PACKAGES[appId] ?: throw InvalidUpiAppException()
      val context = appContext.reactContext ?: throw UpiLauncherContextUnavailableException()
      val launchIntent = context.packageManager.getLaunchIntentForPackage(packageName)
        ?: throw UpiAppUnavailableException()
      launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(launchIntent)
      } catch (error: ActivityNotFoundException) {
        throw UpiAppLaunchException(error)
      } catch (error: SecurityException) {
        throw UpiAppLaunchException(error)
      }
    }
  }
}
