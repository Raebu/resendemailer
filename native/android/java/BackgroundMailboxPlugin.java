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
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "BackgroundMailbox")
public class BackgroundMailboxPlugin extends Plugin {
  static final String PREFS = "gibp_mail_background";
  static final String ACCOUNT_PREFIX = "acct_";
  static final String CAMPAIGN_PREFIX = "campaign_";
  static final String AUTOMATION_KEY = "automation";
  static final String SUPPRESSIONS_KEY = "suppressions";
  static final String AUDIT_KEY = "audit";
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
      putEncrypted(ACCOUNT_PREFIX + id, account.toString());
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
  public void configureAutomation(PluginCall call) {
    String url = call.getString("url");
    String token = call.getString("token");
    String mode = call.getString("mode", "draft");
    Double threshold = call.getDouble("threshold", 0.92);
    Integer maxReplies = call.getInt("maxRepliesPerHour", 10);
    if (url == null || !url.startsWith("https://") || token == null || token.length() < 12) {
      call.reject("HTTPS gateway URL and bearer token are required");
      return;
    }
    try {
      JSONObject cfg = new JSONObject();
      cfg.put("url", url.replaceAll("/+$", ""));
      cfg.put("token", token);
      cfg.put("mode", mode);
      cfg.put("threshold", Math.max(0.5, Math.min(1.0, threshold == null ? 0.92 : threshold)));
      cfg.put("maxRepliesPerHour", Math.max(1, Math.min(25, maxReplies == null ? 10 : maxReplies)));
      putEncrypted(AUTOMATION_KEY, cfg.toString());
      schedule(getContext());
      call.resolve();
    } catch (Exception e) {
      call.reject("Unable to secure automation configuration", e);
    }
  }

  @PluginMethod
  public void setAutomationMode(PluginCall call) {
    String mode = call.getString("mode", "draft");
    Double threshold = call.getDouble("threshold", 0.92);
    Integer maxReplies = call.getInt("maxRepliesPerHour", 10);
    try {
      JSONObject cfg = getEncryptedObject(AUTOMATION_KEY);
      if (cfg == null) {
        call.resolve();
        return;
      }
      cfg.put("mode", mode);
      cfg.put("threshold", Math.max(0.5, Math.min(1.0, threshold == null ? 0.92 : threshold)));
      cfg.put("maxRepliesPerHour", Math.max(1, Math.min(25, maxReplies == null ? 10 : maxReplies)));
      putEncrypted(AUTOMATION_KEY, cfg.toString());
      call.resolve();
    } catch (Exception e) {
      call.reject("Unable to update background automation mode", e);
    }
  }

  @PluginMethod
  public void setSuppressions(PluginCall call) {
    String suppressionsJson = call.getString("suppressionsJson", "[]");
    try {
      JSONArray values = new JSONArray(suppressionsJson);
      putEncrypted(SUPPRESSIONS_KEY, values.toString());
      call.resolve();
    } catch (Exception e) {
      call.reject("Unable to secure suppressions", e);
    }
  }

  @PluginMethod
  public void upsertCampaign(PluginCall call) {
    String id = call.getString("id");
    String campaignJson = call.getString("campaignJson");
    if (id == null || campaignJson == null) {
      call.reject("Campaign id and payload are required");
      return;
    }
    try {
      JSONObject campaign = new JSONObject(campaignJson);
      if (!id.equals(campaign.optString("id"))) campaign.put("id", id);

      JSONObject existing = getEncryptedObject(CAMPAIGN_PREFIX + id);
      if (existing != null) {
        JSONArray oldContacts = existing.optJSONArray("contacts");
        JSONArray newContacts = campaign.optJSONArray("contacts");
        if (oldContacts != null && newContacts != null) {
          java.util.Map<String, JSONObject> oldById = new java.util.HashMap<>();
          for (int i = 0; i < oldContacts.length(); i++) {
            JSONObject oldContact = oldContacts.optJSONObject(i);
            if (oldContact != null) oldById.put(oldContact.optString("id", ""), oldContact);
          }
          for (int i = 0; i < newContacts.length(); i++) {
            JSONObject incoming = newContacts.optJSONObject(i);
            if (incoming == null) continue;
            JSONObject oldContact = oldById.get(incoming.optString("id", ""));
            if (oldContact == null) continue;

            String oldUpdated = oldContact.optString("updatedAt", "");
            String newUpdated = incoming.optString("updatedAt", "");
            if (oldUpdated.compareTo(newUpdated) > 0) {
              String[] fields = {"state","step","nextActionAt","lastSendAt","updatedAt","sendTimes"};
              for (String field : fields) {
                if (oldContact.has(field)) incoming.put(field, oldContact.get(field));
              }
            } else {
              if (!incoming.has("sendTimes") && oldContact.has("sendTimes")) incoming.put("sendTimes", oldContact.get("sendTimes"));
              if (!incoming.has("lastSendAt") && oldContact.has("lastSendAt")) incoming.put("lastSendAt", oldContact.get("lastSendAt"));
            }
          }
        }
      }

      putEncrypted(CAMPAIGN_PREFIX + id, campaign.toString());
      schedule(getContext());
      call.resolve();
    } catch (Exception e) {
      call.reject("Unable to secure campaign", e);
    }
  }

  @PluginMethod
  public void removeCampaign(PluginCall call) {
    String id = call.getString("id");
    if (id != null) prefs().edit().remove(CAMPAIGN_PREFIX + id).apply();
    call.resolve();
  }

  @PluginMethod
  public void getAutomationState(PluginCall call) {
    try {
      JSONArray campaigns = new JSONArray();
      for (Map.Entry<String, ?> entry : prefs().getAll().entrySet()) {
        if (!entry.getKey().startsWith(CAMPAIGN_PREFIX)) continue;
        JSONObject value = getEncryptedObject(entry.getKey());
        if (value != null) campaigns.put(value);
      }
      JSONArray suppressions = getEncryptedArray(SUPPRESSIONS_KEY);
      if (suppressions == null) suppressions = new JSONArray();
      JSONArray audit = getEncryptedArray(AUDIT_KEY);
      if (audit == null) audit = new JSONArray();

      JSObject result = new JSObject();
      result.put("campaigns", campaigns);
      result.put("suppressions", suppressions);
      result.put("audit", audit);
      call.resolve(result);
    } catch (Exception e) {
      call.reject("Unable to read background automation state", e);
    }
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

  static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static void putEncrypted(Context context, String key, String plain) throws Exception {
    prefs(context).edit().putString(key, CryptoBox.encrypt(plain)).apply();
  }

  private void putEncrypted(String key, String plain) throws Exception {
    putEncrypted(getContext(), key, plain);
  }

  static JSONObject getEncryptedObject(Context context, String key) throws Exception {
    String encrypted = prefs(context).getString(key, null);
    if (encrypted == null) return null;
    return new JSONObject(CryptoBox.decrypt(encrypted));
  }

  private JSONObject getEncryptedObject(String key) throws Exception {
    return getEncryptedObject(getContext(), key);
  }

  static JSONArray getEncryptedArray(Context context, String key) throws Exception {
    String encrypted = prefs(context).getString(key, null);
    if (encrypted == null) return null;
    return new JSONArray(CryptoBox.decrypt(encrypted));
  }

  private JSONArray getEncryptedArray(String key) throws Exception {
    return getEncryptedArray(getContext(), key);
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
