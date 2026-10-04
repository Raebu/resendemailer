package global.gibp.mail;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

public class MailSyncWorker extends Worker {
  private static final String CHANNEL = "gibp_mail_incoming";
  private static final int MAX_BACKGROUND_BD_PER_RUN = 6;
  private static final int GLOBAL_BD_PER_HOUR = 25;
  private static final Set<String> AUTO_SAFE = new HashSet<>();
  private static final Set<String> ALWAYS_HUMAN = new HashSet<>();

  static {
    String[] safe = {
      "general_enquiry","availability","acknowledgement","partnership_initial",
      "supplier_initial","support_routine","bd_interest","bd_not_interested"
    };
    String[] human = {
      "legal","regulatory","complaint","payment_dispute","security","privacy",
      "medical","employment","contract","fraud"
    };
    for (String value : safe) AUTO_SAFE.add(value);
    for (String value : human) ALWAYS_HUMAN.add(value);
  }

  private final Context context;
  private final SharedPreferences prefs;

  public MailSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
    this.context = context;
    this.prefs = BackgroundMailboxPlugin.prefs(context);
  }

  @NonNull
  @Override
  public Result doWork() {
    try {
      boolean transientFailure = false;
      Map<String, JSONObject> accounts = readAccounts();
      for (JSONObject account : accounts.values()) {
        try {
          pollAccount(account);
        } catch (java.io.IOException e) {
          transientFailure = true;
        } catch (Exception ignored) {
          // A broken individual account must not block the others.
        }
      }
      try {
        runBackgroundCampaigns(accounts);
      } catch (java.io.IOException e) {
        transientFailure = true;
      } catch (Exception ignored) {
        // Keep mail checks healthy even if campaign automation is misconfigured.
      }
      return transientFailure ? Result.retry() : Result.success();
    } catch (Exception e) {
      return Result.retry();
    }
  }

  private Map<String, JSONObject> readAccounts() throws Exception {
    Map<String, JSONObject> output = new HashMap<>();
    for (String key : prefs.getAll().keySet()) {
      if (!key.startsWith(BackgroundMailboxPlugin.ACCOUNT_PREFIX)) continue;
      JSONObject account = BackgroundMailboxPlugin.getEncryptedObject(context, key);
      if (account == null) continue;
      String id = account.optString("id", "");
      if (!id.isEmpty()) output.put(id, account);
    }
    return output;
  }

  private void pollAccount(JSONObject account) throws Exception {
    String id = account.getString("id");
    String name = account.optString("name", "GIBP Mail");
    String apiKey = account.getString("apiKey");
    JSONObject response = getJson("https://api.resend.com/emails/receiving?limit=100", apiKey);
    JSONArray items = listData(response);
    if (items.length() == 0) return;

    JSONObject first = items.optJSONObject(0);
    String latestId = first == null ? "" : first.optString("id", "");
    if (latestId.isEmpty()) return;
    String last = prefs.getString("last_" + id, null);

    // First run establishes a cursor without sending or notifying against historical mail.
    if (last == null) {
      prefs.edit().putString("last_" + id, latestId).apply();
      return;
    }
    if (latestId.equals(last)) return;

    List<JSONObject> fresh = new ArrayList<>();
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.optJSONObject(i);
      if (item == null) continue;
      String providerId = item.optString("id", "");
      if (providerId.equals(last)) break;
      fresh.add(item);
    }

    Set<String> verifiedDomains = fetchVerifiedDomains(apiKey);
    JSONObject automation = BackgroundMailboxPlugin.getEncryptedObject(context, BackgroundMailboxPlugin.AUTOMATION_KEY);

    // Oldest-to-newest preserves reply/campaign ordering.
    for (int i = fresh.size() - 1; i >= 0; i--) {
      JSONObject summary = fresh.get(i);
      JSONObject detail = summary;
      String providerId = summary.optString("id", "");
      if (!providerId.isEmpty()) {
        try {
          detail = unwrapObject(getJson(
            "https://api.resend.com/emails/receiving/" + urlEncode(providerId),
            apiKey
          ));
        } catch (Exception ignored) {
          // Summary still supports notification; automation will skip if detail is incomplete.
        }
      }

      notifyIncoming(name, summary);
      reconcileCampaignReplies(detail);

      if (automation != null && "auto_safe".equals(automation.optString("mode", "draft"))) {
        try {
          maybeAutoReply(account, detail, verifiedDomains, automation);
        } catch (java.io.IOException e) {
          throw e;
        } catch (Exception e) {
          appendAudit(audit(
            providerId,
            null,
            "escalate",
            false,
            "Background auto-reply error: " + e.getMessage()
          ));
        }
      }
    }
    prefs.edit().putString("last_" + id, latestId).apply();
  }

  private Set<String> fetchVerifiedDomains(String apiKey) {
    Set<String> domains = new HashSet<>();
    try {
      JSONArray items = listData(getJson("https://api.resend.com/domains", apiKey));
      for (int i = 0; i < items.length(); i++) {
        JSONObject d = items.optJSONObject(i);
        if (d == null || !"verified".equalsIgnoreCase(d.optString("status", ""))) continue;
        String name = d.optString("name", d.optString("domain", "")).toLowerCase();
        if (!name.isEmpty()) domains.add(name);
      }
    } catch (Exception ignored) {}
    return domains;
  }

  private void maybeAutoReply(
    JSONObject account,
    JSONObject message,
    Set<String> verifiedDomains,
    JSONObject automation
  ) throws Exception {
    String sender = extractEmail(message.optString("from", ""));
    if (sender.isEmpty() || isSuppressed(sender)) return;

    String subject = message.optString("subject", "");
    String body = message.optString("text", "");
    if (body.isEmpty()) body = stripHtml(message.optString("html", ""));
    if (looksAutomated(subject + " " + body)) return;

    if (containsUnsubscribe(subject + " " + body)) {
      suppress(sender);
      return;
    }

    JSONObject decision = callAi(automation, "inbound", new JSONObject()
      .put("instruction",
        "Classify this single new inbound email and decide the safest useful action. " +
        "Never invent facts, commitments, pricing, regulatory status or prior relationships.")
      .put("conversation",
        "THEM | " + sender + "\nSubject: " + subject + "\n" + body));

    String action = decision.optString("action", "escalate");
    String category = decision.optString("category", "");
    double confidence = decision.optDouble("confidence", 0.0);
    double threshold = automation.optDouble("threshold", 0.92);
    boolean sensitive = decision.optBoolean("sensitive", true);
    boolean unsubscribe = decision.optBoolean("unsubscribe", false);

    if (unsubscribe) {
      suppress(sender);
      appendAudit(audit(message.optString("id", ""), null, action, false, "Unsubscribe detected"));
      return;
    }

    boolean allowed =
      "send_reply".equals(action) &&
      AUTO_SAFE.contains(category) &&
      !ALWAYS_HUMAN.contains(category) &&
      !sensitive &&
      confidence >= threshold &&
      autoReplyCountLastHour() < automation.optInt("maxRepliesPerHour", 10);

    if (!allowed) {
      appendAudit(audit(message.optString("id", ""), null, action, false, "Background policy gate"));
      return;
    }

    String replyBody = decision.optString("body", "").trim();
    if (replyBody.isEmpty()) return;
    String from = verifiedRecipient(message.optJSONArray("to"), verifiedDomains);
    if (from == null) {
      appendAudit(audit(message.optString("id", ""), null, action, false, "No verified reply From address"));
      return;
    }

    String replySubject = decision.optString("subject", "").trim();
    if (replySubject.isEmpty()) {
      replySubject = subject.toLowerCase().startsWith("re:") ? subject : "Re: " + subject;
    }

    JSONObject send = new JSONObject();
    send.put("from", from);
    send.put("to", new JSONArray().put(sender));
    send.put("subject", replySubject);
    send.put("text", replyBody);

    String messageId = message.optString("message_id", "");
    if (!messageId.isEmpty()) {
      JSONObject headers = new JSONObject();
      headers.put("In-Reply-To", messageId);
      headers.put("References", messageId);
      send.put("headers", headers);
    }

    String apiKey = account.getString("apiKey");
    String localId = message.optString("id", UUID.randomUUID().toString());
    postJson(
      "https://api.resend.com/emails",
      apiKey,
      send,
      "gibp-bg-reply-" + localId
    );
    appendAudit(audit(localId, null, "send_reply", true, ""));
  }

  private void reconcileCampaignReplies(JSONObject message) throws Exception {
    String sender = extractEmail(message.optString("from", ""));
    if (sender.isEmpty()) return;
    String content = message.optString("subject", "") + " " +
      message.optString("text", "") + " " + stripHtml(message.optString("html", ""));
    boolean unsub = containsUnsubscribe(content);
    if (unsub) suppress(sender);

    for (String key : prefs.getAll().keySet()) {
      if (!key.startsWith(BackgroundMailboxPlugin.CAMPAIGN_PREFIX)) continue;
      JSONObject campaign = BackgroundMailboxPlugin.getEncryptedObject(context, key);
      if (campaign == null) continue;
      JSONArray contacts = campaign.optJSONArray("contacts");
      if (contacts == null) continue;
      boolean changed = false;
      for (int i = 0; i < contacts.length(); i++) {
        JSONObject contact = contacts.optJSONObject(i);
        if (contact == null) continue;
        if (!sender.equalsIgnoreCase(contact.optString("email", ""))) continue;
        contact.put("state", unsub ? "unsubscribed" : "replied");
        contact.put("updatedAt", Instant.now().toString());
        changed = true;
      }
      if (changed) {
        BackgroundMailboxPlugin.putEncrypted(context, key, campaign.toString());
      }
    }
  }

  private void runBackgroundCampaigns(Map<String, JSONObject> accounts) throws Exception {
    JSONObject automation = BackgroundMailboxPlugin.getEncryptedObject(context, BackgroundMailboxPlugin.AUTOMATION_KEY);
    if (automation == null) return;

    List<String> keys = new ArrayList<>();
    List<JSONObject> campaigns = new ArrayList<>();
    for (String key : prefs.getAll().keySet()) {
      if (!key.startsWith(BackgroundMailboxPlugin.CAMPAIGN_PREFIX)) continue;
      JSONObject campaign = BackgroundMailboxPlugin.getEncryptedObject(context, key);
      if (campaign == null || !"active".equals(campaign.optString("status", ""))) continue;
      keys.add(key);
      campaigns.add(campaign);
    }

    long now = System.currentTimeMillis();
    int globalHour = countAllCampaignSends(campaigns, now - 3_600_000L);
    int budget = Math.min(MAX_BACKGROUND_BD_PER_RUN, Math.max(0, GLOBAL_BD_PER_HOUR - globalHour));
    if (budget <= 0) return;

    for (int ci = 0; ci < campaigns.size() && budget > 0; ci++) {
      JSONObject campaign = campaigns.get(ci);
      String key = keys.get(ci);
      JSONObject account = accounts.get(campaign.optString("accountId", ""));
      if (account == null) continue;

      int perHourLimit = Math.min(25, Math.max(1, campaign.optInt("maxPerHour", 25)));
      int perDayLimit = Math.max(1, campaign.optInt("maxPerDay", 100));
      int perHour = countCampaignSends(campaign, now - 3_600_000L);
      int perDay = countCampaignSends(campaign, now - 86_400_000L);
      if (perHour >= perHourLimit || perDay >= perDayLimit) continue;

      JSONArray contacts = campaign.optJSONArray("contacts");
      if (contacts == null) continue;
      boolean changed = false;

      for (int i = 0; i < contacts.length() && budget > 0; i++) {
        JSONObject contact = contacts.optJSONObject(i);
        if (contact == null) continue;

        String email = contact.optString("email", "").toLowerCase();
        if (email.isEmpty()) continue;
        if (isSuppressed(email)) {
          contact.put("state", "suppressed");
          changed = true;
          continue;
        }

        String state = contact.optString("state", "queued");
        int step = contact.optInt("step", 0);
        if (!("queued".equals(state) || "sent".equals(state))) continue;
        if (step >= 3) {
          contact.put("state", "complete");
          changed = true;
          continue;
        }

        String nextActionAt = contact.optString("nextActionAt", "");
        if (!nextActionAt.isEmpty() && parseTime(nextActionAt) > now) continue;
        if (perHour >= perHourLimit || perDay >= perDayLimit) break;

        String task = step > 0 ? "followup" : "outreach";
        JSONObject payload = new JSONObject();
        payload.put("objective", campaign.optString("objective", ""));
        payload.put("sender", campaign.optString("fromAddress", ""));
        payload.put("step", step);
        payload.put("contact", new JSONObject()
          .put("name", contact.optString("name", ""))
          .put("email", email)
          .put("company", contact.optString("company", ""))
          .put("context", contact.optString("context", "")));
        payload.put("instruction",
          "Write concise, factual, personalised B2B outreach. Do not pretend there was prior contact " +
          "unless supplied context proves it. No pressure, deception or invented claims.");

        JSONObject decision;
        try {
          decision = callAi(automation, task, payload);
        } catch (java.io.IOException e) {
          throw e;
        } catch (Exception e) {
          appendAudit(audit(null, campaign.optString("id", ""), "escalate", false, "AI error: " + e.getMessage()));
          continue;
        }

        boolean sensitive = decision.optBoolean("sensitive", true);
        boolean unsubscribe = decision.optBoolean("unsubscribe", false);
        String text = decision.optString("body", "").trim();
        if (sensitive || unsubscribe || text.isEmpty()) {
          contact.put("state", "needs_review");
          contact.put("updatedAt", Instant.now().toString());
          appendAudit(audit(null, campaign.optString("id", ""), decision.optString("action", "escalate"), false, "Background policy gate"));
          changed = true;
          continue;
        }

        String subject = decision.optString("subject", "").trim();
        if (subject.isEmpty()) subject = campaign.optString("name", "Introduction");
        JSONObject send = new JSONObject()
          .put("from", campaign.optString("fromAddress", ""))
          .put("to", new JSONArray().put(email))
          .put("subject", subject)
          .put("text", text);

        String contactId = contact.optString("id", UUID.randomUUID().toString());
        postJson(
          "https://api.resend.com/emails",
          account.getString("apiKey"),
          send,
          "gibp-bg-bd-" + campaign.optString("id", "") + "-" + contactId + "-" + step
        );

        String sentAt = Instant.now().toString();
        JSONArray sendTimes = contact.optJSONArray("sendTimes");
        if (sendTimes == null) sendTimes = new JSONArray();
        sendTimes.put(sentAt);
        while (sendTimes.length() > 20) sendTimes.remove(0);
        contact.put("sendTimes", sendTimes);
        contact.put("lastSendAt", sentAt);
        contact.put("step", step + 1);
        contact.put("state", "sent");
        int followDays = Math.max(1, Math.min(14,
          decision.optInt("follow_up_days", campaign.optInt("followupDays", 3))
        ));
        contact.put("nextActionAt", Instant.ofEpochMilli(
          System.currentTimeMillis() + followDays * 86_400_000L
        ).toString());
        contact.put("updatedAt", sentAt);

        appendAudit(audit(null, campaign.optString("id", ""), "create_outreach", true, ""));
        changed = true;
        budget--;
        perHour++;
        perDay++;
      }

      if (changed) {
        BackgroundMailboxPlugin.putEncrypted(context, key, campaign.toString());
      }
    }
  }

  private JSONObject callAi(JSONObject automation, String task, JSONObject payload) throws Exception {
    String url = automation.getString("url") + "/v1/decision";
    String token = automation.getString("token");
    JSONObject input = new JSONObject().put("task", task).put("payload", payload);
    return postJson(url, token, input, null, true);
  }

  private JSONObject postJson(String url, String bearer, JSONObject body, String idempotencyKey) throws Exception {
    return postJson(url, bearer, body, idempotencyKey, false);
  }

  private JSONObject postJson(
    String url,
    String bearer,
    JSONObject body,
    String idempotencyKey,
    boolean rawBearer
  ) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setRequestMethod("POST");
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(60000);
    connection.setDoOutput(true);
    connection.setRequestProperty("Authorization", "Bearer " + bearer);
    connection.setRequestProperty("Content-Type", "application/json");
    connection.setRequestProperty("Accept", "application/json");
    if (idempotencyKey != null && !idempotencyKey.isEmpty()) {
      connection.setRequestProperty("Idempotency-Key", idempotencyKey);
    }

    byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
    try (OutputStream out = connection.getOutputStream()) {
      out.write(payload);
    }

    int status = connection.getResponseCode();
    if (status == 429 || status >= 500) {
      connection.disconnect();
      throw new java.io.IOException("Transient HTTP " + status);
    }
    BufferedReader reader = new BufferedReader(new InputStreamReader(
      status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream()
    ));
    StringBuilder response = new StringBuilder();
    String line;
    while ((line = reader.readLine()) != null) response.append(line);
    reader.close();
    connection.disconnect();

    JSONObject json = response.length() == 0 ? new JSONObject() : new JSONObject(response.toString());
    if (status < 200 || status >= 300) {
      throw new IllegalStateException(json.optString("error", json.optString("message", "HTTP " + status)));
    }
    return json;
  }

  private JSONObject getJson(String url, String apiKey) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setRequestMethod("GET");
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(25000);
    connection.setRequestProperty("Authorization", "Bearer " + apiKey);
    connection.setRequestProperty("Accept", "application/json");
    int status = connection.getResponseCode();
    if (status == 429 || status >= 500) throw new java.io.IOException("Transient Resend HTTP " + status);
    if (status < 200 || status >= 300) throw new IllegalStateException("Resend HTTP " + status);
    BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()));
    StringBuilder body = new StringBuilder();
    String line;
    while ((line = reader.readLine()) != null) body.append(line);
    reader.close();
    connection.disconnect();
    return new JSONObject(body.toString());
  }

  private JSONArray listData(JSONObject response) {
    JSONArray direct = response.optJSONArray("data");
    if (direct != null) return direct;
    JSONObject nested = response.optJSONObject("data");
    if (nested != null) {
      JSONArray nestedData = nested.optJSONArray("data");
      if (nestedData != null) return nestedData;
    }
    return new JSONArray();
  }

  private JSONObject unwrapObject(JSONObject response) {
    JSONObject nested = response.optJSONObject("data");
    return nested == null ? response : nested;
  }

  private String verifiedRecipient(JSONArray recipients, Set<String> verifiedDomains) {
    if (recipients == null) return null;
    for (int i = 0; i < recipients.length(); i++) {
      String address = extractEmail(recipients.optString(i, ""));
      int at = address.lastIndexOf('@');
      if (at <= 0) continue;
      String domain = address.substring(at + 1).toLowerCase();
      if (verifiedDomains.contains(domain)) return address;
    }
    return null;
  }

  private String extractEmail(String raw) {
    String value = raw == null ? "" : raw.trim();
    int left = value.lastIndexOf('<');
    int right = value.lastIndexOf('>');
    if (left >= 0 && right > left) value = value.substring(left + 1, right);
    value = value.trim().toLowerCase();
    return value.contains("@") ? value : "";
  }

  private boolean containsUnsubscribe(String text) {
    String value = text == null ? "" : text.toLowerCase();
    return value.contains("unsubscribe") ||
      value.contains("do not contact") ||
      value.contains("stop emailing") ||
      value.contains("remove me");
  }

  private boolean looksAutomated(String text) {
    String value = text == null ? "" : text.toLowerCase();
    return value.contains("automatic reply") ||
      value.contains("auto-reply") ||
      value.contains("out of office") ||
      value.contains("mailer-daemon") ||
      value.contains("delivery status notification");
  }

  private String stripHtml(String html) {
    if (html == null || html.isEmpty()) return "";
    return html.replaceAll("<[^>]+>", " ").replaceAll("\\s+", " ").trim();
  }

  private boolean isSuppressed(String email) throws Exception {
    JSONArray list = BackgroundMailboxPlugin.getEncryptedArray(context, BackgroundMailboxPlugin.SUPPRESSIONS_KEY);
    if (list == null) return false;
    for (int i = 0; i < list.length(); i++) {
      if (email.equalsIgnoreCase(list.optString(i, ""))) return true;
    }
    return false;
  }

  private void suppress(String email) throws Exception {
    JSONArray list = BackgroundMailboxPlugin.getEncryptedArray(context, BackgroundMailboxPlugin.SUPPRESSIONS_KEY);
    if (list == null) list = new JSONArray();
    for (int i = 0; i < list.length(); i++) {
      if (email.equalsIgnoreCase(list.optString(i, ""))) return;
    }
    list.put(email.toLowerCase());
    BackgroundMailboxPlugin.putEncrypted(context, BackgroundMailboxPlugin.SUPPRESSIONS_KEY, list.toString());
  }

  private JSONObject audit(String messageId, String campaignId, String action, boolean executed, String error) {
    JSONObject row = new JSONObject();
    try {
      row.put("id", "bg_" + UUID.randomUUID());
      row.put("messageId", messageId == null ? JSONObject.NULL : messageId);
      row.put("campaignId", campaignId == null ? JSONObject.NULL : campaignId);
      row.put("action", action);
      row.put("executed", executed);
      row.put("error", error == null || error.isEmpty() ? JSONObject.NULL : error);
      row.put("createdAt", Instant.now().toString());
    } catch (Exception ignored) {}
    return row;
  }

  private void appendAudit(JSONObject row) throws Exception {
    JSONArray audit = BackgroundMailboxPlugin.getEncryptedArray(context, BackgroundMailboxPlugin.AUDIT_KEY);
    if (audit == null) audit = new JSONArray();
    audit.put(row);
    while (audit.length() > 500) audit.remove(0);
    BackgroundMailboxPlugin.putEncrypted(context, BackgroundMailboxPlugin.AUDIT_KEY, audit.toString());
  }

  private int autoReplyCountLastHour() throws Exception {
    JSONArray audit = BackgroundMailboxPlugin.getEncryptedArray(context, BackgroundMailboxPlugin.AUDIT_KEY);
    if (audit == null) return 0;
    long cutoff = System.currentTimeMillis() - 3_600_000L;
    int count = 0;
    for (int i = 0; i < audit.length(); i++) {
      JSONObject row = audit.optJSONObject(i);
      if (row == null || !row.optBoolean("executed", false)) continue;
      if (!"send_reply".equals(row.optString("action", ""))) continue;
      if (parseTime(row.optString("createdAt", "")) >= cutoff) count++;
    }
    return count;
  }

  private int countAllCampaignSends(List<JSONObject> campaigns, long cutoff) {
    int total = 0;
    for (JSONObject campaign : campaigns) total += countCampaignSends(campaign, cutoff);
    return total;
  }

  private int countCampaignSends(JSONObject campaign, long cutoff) {
    JSONArray contacts = campaign.optJSONArray("contacts");
    if (contacts == null) return 0;
    int count = 0;
    for (int i = 0; i < contacts.length(); i++) {
      JSONObject contact = contacts.optJSONObject(i);
      if (contact == null) continue;
      JSONArray times = contact.optJSONArray("sendTimes");
      if (times == null) continue;
      for (int x = 0; x < times.length(); x++) {
        if (parseTime(times.optString(x, "")) >= cutoff) count++;
      }
    }
    return count;
  }

  private long parseTime(String value) {
    if (value == null || value.isEmpty()) return 0L;
    try { return Instant.parse(value).toEpochMilli(); } catch (Exception ignored) { return 0L; }
  }

  private String urlEncode(String value) {
    try { return java.net.URLEncoder.encode(value, "UTF-8"); }
    catch (Exception e) { return value; }
  }

  private void notifyIncoming(String accountName, JSONObject item) {
    if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      return;
    }
    NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel channel = new NotificationChannel(CHANNEL, "Incoming mail", NotificationManager.IMPORTANCE_DEFAULT);
      channel.setDescription("New GIBP Mail messages");
      manager.createNotificationChannel(channel);
    }

    String from = item.optString("from", accountName);
    String subject = item.optString("subject", "New email");
    Intent intent = new Intent(context, MainActivity.class);
    intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent pending = PendingIntent.getActivity(
      context,
      Math.abs(item.optString("id", subject).hashCode()),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
    );

    NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(context.getApplicationInfo().icon)
      .setContentTitle(from)
      .setContentText(subject)
      .setStyle(new NotificationCompat.BigTextStyle().bigText(subject))
      .setAutoCancel(true)
      .setContentIntent(pending)
      .setCategory(NotificationCompat.CATEGORY_EMAIL)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT);

    manager.notify(Math.abs((item.optString("id", subject) + accountName).hashCode()), notification.build());
  }
}
