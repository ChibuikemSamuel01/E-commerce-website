import { createClient } from "npm:@supabase/supabase-js@2";

type CartProduct = {
  id: string;
  name: string;
  price: number | string;
  stock: number;
  active: boolean;
};

type CartRow = {
  product_id: string;
  quantity: number;
  products: CartProduct | null;
};

type PaymentAttempt = {
  reference: string;
  user_id: string;
  amount_kobo: number | string;
  currency: string;
  status: string;
  order_id: string | null;
};

const encoder = new TextEncoder();
const encoder = new TextEncoder();
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, paystack-signature, x-paystack-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getDefaultKey(mapName: string, legacyName: string) {
  const keyMap = JSON.parse(Deno.env.get(mapName) || "{}") as Record<string, string>;
  return keyMap.default || Deno.env.get(legacyName) || "";
}

function createAdminClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = getDefaultKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase server credentials are not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function getUser(request: Request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = getDefaultKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  if (!token || !url || !key) throw new Error("Sign in before starting payment");
  const client = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Your sign-in session has expired");
  return { user: data.user, client };
}

async function paystackRequest(path: string, secret: string, init?: RequestInit) {
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
  });
  const result = await response.json();
  if (!response.ok || result.status !== true) {
    throw new Error(result.message || "Paystack request failed");
  }
  return result.data;
}

function validShippingAddress(address: Record<string, unknown>) {
  return ["first-name", "last-name", "address", "city", "state", "postal-code", "email", "tel"]
    .every((field) => typeof address[field] === "string" && address[field].trim().length > 0);
}

async function preparePayment(request: Request, body: Record<string, unknown>) {
  const { user, client } = await getUser(request);
  if (!user.email) throw new Error("Your account needs an email address to use Paystack");
  const address = body.shippingAddress;
  if (!address || typeof address !== "object" || !validShippingAddress(address as Record<string, unknown>)) {
    throw new Error("Complete the shipping details before paying");
  }

  const { data, error } = await client
    .from("cart_items")
    .select("product_id,quantity,products!inner(id,name,price,stock,active)")
    .eq("user_id", user.id);
  if (error) throw new Error("Could not load your cart");
  const rows = (data || []) as unknown as CartRow[];
  if (rows.length === 0) throw new Error("Your cart is empty");

  const items = rows.map((row) => {
    const product = row.products;
    const unitPrice = Number(product?.price);
    if (!product || !product.active || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error("Your cart contains an unavailable product");
    }
    if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 99 || row.quantity > product.stock) {
      throw new Error(`Not enough stock for ${product.name}`);
    }
    return {
      product_id: product.id,
      product_name: product.name,
      unit_price: unitPrice,
      quantity: row.quantity,
    };
  });
  const amountKobo = items.reduce(
    (sum, item) => sum + Math.round(item.unit_price * 100) * item.quantity,
    0,
  );
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) throw new Error("Invalid order total");

  const reference = `store${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createAdminClient();
  const { error: attemptError } = await admin.from("paystack_payment_attempts").insert({
    reference,
    user_id: user.id,
    amount_kobo: amountKobo,
    currency: "NGN",
    shipping_address: address,
    items,
  });
  if (attemptError) throw new Error("Could not prepare your payment");
  return { reference, amount_kobo: amountKobo, email: user.email };
}

async function markAttemptFailed(reference: string, userId?: string) {
  const admin = createAdminClient();
  let query = admin.from("paystack_payment_attempts")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("reference", reference).eq("status", "pending");
  if (userId) query = query.eq("user_id", userId);
  const { error } = await query;
  if (error) throw new Error("Could not update payment attempt");
}

async function startRefund(reference: string, secret: string) {
  try {
    await paystackRequest("/refund", secret, {
      method: "POST",
      body: JSON.stringify({ transaction: reference }),
    });
    return true;
  } catch (error) {
    console.error("Could not start Paystack refund", error);
    return false;
  }
}

async function verifyAndComplete(reference: string, secret: string, userId?: string) {
  const admin = createAdminClient();
  const { data: row, error } = await admin.from("paystack_payment_attempts")
    .select("reference,user_id,amount_kobo,currency,status,order_id")
    .eq("reference", reference).maybeSingle();
  if (error || !row) throw new Error("Payment attempt not found");
  const attempt = row as PaymentAttempt;
  if (userId && attempt.user_id !== userId) throw new Error("Payment attempt does not belong to this account");
  if (attempt.status === "paid" && attempt.order_id) return { order_id: attempt.order_id };
  if (attempt.status !== "pending") throw new Error("This payment attempt is no longer active");

  const transaction = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, secret);
  const matches = transaction.status === "success" &&
    transaction.reference === reference &&
    transaction.amount === Number(attempt.amount_kobo) &&
    transaction.currency === attempt.currency;
  if (!matches) {
    const refunded = transaction.status === "success" && await startRefund(reference, secret);
    await admin.from("paystack_payment_attempts").update({
      status: refunded ? "refunded" : "failed",
      updated_at: new Date().toISOString(),
    }).eq("reference", reference).eq("status", "pending");
    throw new Error(refunded
      ? "Payment details did not match; a refund has been started."
      : "Paystack has not confirmed the expected payment.");
  }

  const { data: orderId, error: orderError } = await admin.rpc("complete_paystack_order", {
    p_user_id: attempt.user_id,
    p_reference: reference,
  });
  if (!orderError && orderId) return { order_id: orderId };

  const { data: latest } = await admin.from("paystack_payment_attempts")
    .select("status,order_id").eq("reference", reference).maybeSingle();
  if (latest?.status === "paid" && latest.order_id) return { order_id: latest.order_id };

  const refunded = await startRefund(reference, secret);
  if (refunded) {
    await admin.from("paystack_payment_attempts").update({
      status: "refunded",
      updated_at: new Date().toISOString(),
    }).eq("reference", reference).eq("status", "pending");
    throw new Error("Payment was received but stock changed; a refund has been started.");
  }
  throw new Error("Payment was received but the order could not be completed. Contact support.");
}

async function signSha512(secret: string, message: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalHex(left: string, right: string) {
  if (!/^[0-9a-f]{128}$/i.test(left) || !/^[0-9a-f]{128}$/i.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function validWebhookSignature(request: Request, rawBody: Uint8Array, secret: string) {
  const header = request.headers.get("paystack-signature");
  if (header) {
    const webhookSecret = Deno.env.get("PAYSTACK_WEBHOOK_SECRET") || secret;
    let timestamp = "";
    const signatures: string[] = [];
    for (const part of header.split(",")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name === "t") timestamp = value;
      if (name === "v1") {
        const signatureSeparator = value.indexOf(":");
        signatures.push(signatureSeparator < 0 ? value : value.slice(signatureSeparator + 1));
      }
    }
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
    const message = new Uint8Array([...encoder.encode(`${timestamp}.`), ...rawBody]);
    const expected = await signSha512(webhookSecret, message);
    return signatures.some((signature) => equalHex(signature, expected));
  }
  const legacy = request.headers.get("x-paystack-signature");
  return Boolean(legacy && equalHex(legacy, await signSha512(secret, rawBody)));
}

async function handleWebhook(request: Request, rawBody: Uint8Array, secret: string) {
  if (!await validWebhookSignature(request, rawBody, secret)) {
    return jsonResponse({ error: "Invalid Paystack signature" }, 401);
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return jsonResponse({ error: "Invalid webhook payload" }, 400);
  }
  if (event.event !== "charge.success") return jsonResponse({ received: true });
  const reference = (event.data as Record<string, unknown> | undefined)?.reference;
  if (typeof reference !== "string") return jsonResponse({ error: "Missing payment reference" }, 400);
  try {
    await verifyAndComplete(reference, secret);
    return jsonResponse({ received: true });
  } catch (error) {
    console.error("Paystack webhook processing failed", error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Could not process payment" }, 500);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY") || "";
  if (!secret.startsWith("sk_test_")) {
    return jsonResponse({ error: "Configure a Paystack sk_test_ secret key to use test checkout." }, 503);
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (request.headers.has("paystack-signature") || request.headers.has("x-paystack-signature")) {
    return await handleWebhook(request, rawBody, secret);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  try {
    if (body.action === "prepare") {
      return jsonResponse(await preparePayment(request, body));
    }
    if (body.action === "cancel" && typeof body.reference === "string") {
      const { user } = await getUser(request);
      await markAttemptFailed(body.reference, user.id);
      return jsonResponse({ cancelled: true });
    }
    if (body.action === "verify" && typeof body.reference === "string") {
      const { user } = await getUser(request);
      return jsonResponse(await verifyAndComplete(body.reference, secret, user.id));
    }
    return jsonResponse({ error: "Unsupported payment action" }, 400);
  } catch (error) {
    console.error("Paystack payment request failed", error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Paystack request failed" }, 400);
  }
});
