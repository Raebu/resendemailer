package global.gibp.mail;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

@CapacitorPlugin(name = "BackgroundMailbox")
public class BackgroundMailboxPlugin extends Plugin {
  static final String PREFS = "gibp_mail_background";
  static final String ACCOUNT_PREFIX = "acct_";
  static final String PERIODIC_NAME = "gibp_mail_background_periodic";

  @PluginMethod
  public void configureAccount(PluginCall call) {
    String id = call.getString("id");
    String name = call.getString("name");
    String apiKey = call.getString("apiKey");
    if (id == null || apiKey == null || !apiKey.startsWith("re_")) {
      call.reject("Valid account id and Resend API key are required");
      return;
    }
    try {
      JSONObject account = new JSONObject();
      account.put("id", id);
      account.put("name", name == null ? "Resend" : name);
      account.put("apiKey", apiKey);
      prefs().edit().putString(ACCOUNT_PREFIX + id, CryptoBox.encrypt(account.toString())).apply();
      schedule(getContext());
      call.resolve();
    } catch (Exception e) {
      call.reject("Unable to secure background account", e);
    }
  }

  @PluginMethod
  public void removeAccount(PluginCall call) {
    String id = call.getString("id");
    if (id != null) {
      prefs().edit()
        .remove(ACCOUNT_PREFIX + id)
        .remove("last_" + id)
        .apply();
    }
    call.resolve();
  }

  @PluginMethod
  public void syncNow(PluginCall call) {
    WorkManager.getInstance(getContext()).enqueue(
      new OneTimeWorkRequest.Builder(MailSyncWorker.class)
        .setConstraints(networkConstraints())
        .build()
    );
    call.resolve();
  }

  private SharedPreferences prefs() {
    return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static Constraints networkConstraints() {
    return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
  }

  static void schedule(Context context) {
    PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(MailSyncWorker.class, 15, TimeUnit.MINUTES)
      .setConstraints(networkConstraints())
      .build();
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
      PERIODIC_NAME,
      ExistingPeriodicWorkPolicy.UPDATE,
      request
    );
  }
}
