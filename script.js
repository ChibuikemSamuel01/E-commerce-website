const SUPABASE_CONFIGURED =
  typeof window.supabase !== "undefined" &&
  typeof window.SUPABASE_URL === "string" &&
  typeof window.SUPABASE_ANON_KEY === "string" &&
  !window.SUPABASE_URL.includes("YOUR-PROJECT") &&
  !window.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");

const db = SUPABASE_CONFIGURED
  ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
  : null;

const readStored = (key) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.error(`Could not read ${key} from local storage.`, error);
    return [];
  }
};

let carts = readStored("carts");
let wishlistCart = readStored("wishlistCart");
let currentUser = null;

const cartCount = document.querySelector(".counter");
const wishCount = document.querySelector(".wishcount");
const cartDisplay = document.querySelector(".cart-item");
const productTotal = document.getElementById("ProductTotal");
const subTotal = document.getElementById("SubTotal");
const summary = document.querySelector(".summary");

function showMessage(message, isError = false) {
  let status = document.getElementById("store-message");
  if (!status) {
    status = document.createElement("p");
    status.id = "store-message";
    status.setAttribute("role", "status");
    status.style.cssText =
      "position:fixed;bottom:16px;left:16px;z-index:2000;padding:12px 16px;background:#fff;border:1px solid #bbb;border-radius:8px;max-width:min(420px,90vw);box-shadow:0 2px 12px #0002";
    document.body.append(status);
  }
  status.textContent = message;
  status.style.color = isError ? "#a00000" : "#172554";
  status.hidden = false;
  window.clearTimeout(showMessage.timeout);
  showMessage.timeout = window.setTimeout(() => {
    status.hidden = true;
  }, 7000);
}

function reportError(context, error) {
  const details = {
    code: error.code,
    message: error.message || "Please try again.",
    details: error.details || undefined,
    hint: error.hint || undefined,
  };
  console.error(`${context}: ${JSON.stringify(details)}`);
  if (error.code === "PGRST205" && error.message?.includes("public.products")) {
    const grids = document.querySelectorAll(".autogrid, .main1-grid");
    grids.forEach((grid) => {
      if (grid.childElementCount > 0) return;
      const notice = document.createElement("div");
      notice.className = "catalog-unavailable";
      const text = document.createElement("p");
      text.textContent = "The Supabase product catalog hasn’t been set up yet.";
      const setupLink = document.createElement("a");
      setupLink.href = `https://supabase.com/dashboard/project/${encodeURIComponent(
        window.SUPABASE_URL.split("//")[1].split(".")[0],
      )}/sql/new`;
      setupLink.target = "_blank";
      setupLink.rel = "noopener noreferrer";
      setupLink.textContent = "Open this project’s SQL Editor";
      notice.append(text, setupLink);
      grid.append(notice);
    });
    return;
  }
  showMessage(`${context}: ${details.message}`, true);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function priceText(value) {
  return `₦${Number(value || 0).toLocaleString("en-NG")}`;
}

function isDatabaseId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function getPostAuthPath() {
  const requestedPath = new URLSearchParams(window.location.search).get("next") ||
    localStorage.getItem("returnAfterLogin") ||
    "index.html";
  return /^(shopping|payment|review)\.html$/.test(requestedPath)
    ? requestedPath
    : "index.html";
}

function getAuthRedirectUrl(mode = "signin") {
  if (!["http:", "https:"].includes(window.location.protocol)) return null;
  const callback = new URL("./login.html", window.location.href);
  callback.searchParams.set("mode", mode);
  callback.searchParams.set("next", getPostAuthPath());
  return callback.toString();
}

function goToPostAuthPath() {
  const nextPath = getPostAuthPath();
  localStorage.removeItem("returnAfterLogin");
  window.location.assign(`./${nextPath}`);
}

function saveCart() {
  if (currentUser) localStorage.removeItem("carts");
  else localStorage.setItem("carts", JSON.stringify(carts));
  if (cartCount) cartCount.textContent = String(carts.length);
}

function saveWishlist() {
  if (currentUser) localStorage.removeItem("wishlistCart");
  else localStorage.setItem("wishlistCart", JSON.stringify(wishlistCart));
  if (wishCount) wishCount.textContent = String(wishlistCart.length);
}

function renderProductCard(product) {
  const image = escapeHtml(product.image_url || "");
  const name = escapeHtml(product.name);
  const category = escapeHtml(product.category);
  const id = escapeHtml(product.id);
  return `
    <div id="${id}" class="product-card" data-product-id="${id}">
      <img src="${image}" alt="${name}">
      <div>
        <p>${category}</p>
        <h1>${name}</h1>
        <div class="stress">
          <i class="fa fa-star" aria-hidden="true"></i>
          <i class="fa fa-star" aria-hidden="true"></i>
          <i class="fa fa-star" aria-hidden="true"></i>
          <i class="fa fa-star" aria-hidden="true"></i>
          <i class="fa fa-star" aria-hidden="true"></i>
          <h4>(0)</h4>
        </div>
        <div class="good">
          <h2>${priceText(product.price)}</h2>
          <div class="omo"><button class="Add-to-cart" type="button">Add</button></div>
        </div>
        <i class="fa fa-heart" aria-label="Add to wishlist" role="button" tabindex="0"></i>
      </div>
    </div>`;
}

async function loadProducts() {
  const grids = [...document.querySelectorAll(".autogrid, .main1-grid")];
  if (!db || grids.length === 0) return;

  const path = window.location.pathname.toLowerCase();
  const categoryByPage = {
    "laptop.html": "Laptops",
    "phone.html": "Phones",
    "tablets.html": "Tablets",
    "accessories.html": "Accessories",
  };
  const category = Object.entries(categoryByPage).find(([page]) =>
    path.endsWith(page),
  )?.[1];

  let query = db
    .from("products")
    .select("id,name,category,price,image_url,stock")
    .eq("active", true)
    .order("created_at", { ascending: false });
  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) {
    reportError("Could not load products", error);
    return;
  }
  if (data.length === 0) {
    grids.forEach((grid) => {
      grid.replaceChildren();
      const empty = document.createElement("p");
      empty.textContent = "No products are available in this category yet.";
      grid.append(empty);
    });
    return;
  }
  grids.forEach((grid) => {
    const products = grid.classList.contains("main1-grid") ? data.slice(0, 4) : data;
    grid.innerHTML = products.map(renderProductCard).join("");
  });
  markWishlistProducts();
}

function updateCartUI() {
  saveCart();
  if (summary) summary.classList.toggle("is-visible", carts.length > 0);
  if (productTotal) productTotal.textContent = "0";
  if (subTotal) subTotal.textContent = "0";
  if (!cartDisplay) return;

  if (carts.length === 0) {
    cartDisplay.innerHTML = '<p class="empty-cart">Your cart is empty</p>';
    return;
  }

  let total = 0;
  cartDisplay.innerHTML = `
    <div class="options">
      <button type="button">Product</button>
      <div class="option"><button type="button">Price</button><button type="button">Quantity</button><button type="button">Subtotal</button></div>
    </div>
    ${carts.map((product, index) => {
      const price = Number(product.priceNumber) || 0;
      const quantity = Number(product.quantity) || 1;
      total += price * quantity;
      return `
        <div class="product001">
          <div class="product002">
            <div class="product00">
              <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.titleName)}">
              <div class="product0"><h1>${escapeHtml(product.titleName)}</h1><p>${escapeHtml(product.category || "Product")}</p></div>
            </div>
            <div class="product003">
              <div><p>${priceText(price)}</p></div>
              <div class="bot">
                <button class="minus" data-index="${index}" aria-label="Decrease quantity">-</button>
                <span>${quantity}</span>
                <button class="plus" data-index="${index}" aria-label="Increase quantity">+</button>
              </div>
              <div><p>${priceText(price * quantity)}</p></div>
            </div>
          </div>
          <div><button class="remove" data-index="${index}" aria-label="Remove item">×</button></div>
        </div>`;
    }).join("")}`;
  if (productTotal) productTotal.textContent = priceText(total);
  if (subTotal) subTotal.textContent = priceText(total);
}

function updateShippingSummary() {
  const shipping = document.querySelector(".shipping-item");
  if (!shipping) return;
  let total = 0;
  if (carts.length === 0) {
    shipping.textContent = "Your cart is empty";
  } else {
    shipping.innerHTML = carts.map((product) => {
      const price = Number(product.priceNumber) || 0;
      const quantity = Number(product.quantity) || 1;
      total += price * quantity;
      return `<div class="payyy">
        <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.titleName)}">
        <div class="initial"><h2>${escapeHtml(product.titleName)}</h2>
          <div class="feel"><div class="none"><p>Qty:</p><span>${quantity}</span></div><div><h3>${priceText(price)}</h3></div></div>
        </div>
      </div>`;
    }).join("");
  }
  const totalNode = document.getElementById("totall");
  const subtotalNode = document.getElementById("sub");
  if (totalNode) totalNode.textContent = priceText(total);
  if (subtotalNode) subtotalNode.textContent = priceText(total);
  const reviewSubtotal = document.getElementById("ProductTotal");
  const reviewTotal = document.getElementById("SubTotal");
  if (reviewSubtotal) reviewSubtotal.textContent = priceText(total);
  if (reviewTotal) reviewTotal.textContent = priceText(total);
}

function markWishlistProducts() {
  document.querySelectorAll(".product-card").forEach((card) => {
    const id = card.dataset.productId || card.id;
    const heart = card.querySelector(".fa-heart");
    if (heart) heart.classList.toggle("active", wishlistCart.some((item) => item.id === id));
  });
}

function updateWishlistUI() {
  saveWishlist();
  const container = document.querySelector(".wishlist-item");
  if (!container) {
    markWishlistProducts();
    return;
  }
  if (wishlistCart.length === 0) {
    container.innerHTML = `<p>Your wishlist is empty</p><div class="btunn"><a href="./index.html">Continue Shopping</a></div>`;
    return;
  }
  container.innerHTML = wishlistCart.map((product, index) => `
    <div class="prodcuts">
      <img src="${escapeHtml(product.img)}" alt="${escapeHtml(product.title)}">
      <button class="iconss" data-index="${index}" aria-label="Remove from wishlist"><i class="fa fa-heart" aria-hidden="true"></i></button>
      <div><p>${escapeHtml(product.category || "Product")}</p><h1>${escapeHtml(product.title)}</h1>
        <div class="stress"><i class="fa fa-star" aria-hidden="true"></i><i class="fa fa-star" aria-hidden="true"></i><i class="fa fa-star" aria-hidden="true"></i><i class="fa fa-star" aria-hidden="true"></i><i class="fa fa-star" aria-hidden="true"></i><h4>(0)</h4></div>
        <div class="Good"><h2>${priceText(product.priceNumber)}</h2><button class="wishlist-add" data-index="${index}" type="button">Add to cart</button></div>
      </div>
    </div>`).join("");
  markWishlistProducts();
}

async function persistCartItem(item) {
  if (!db || !currentUser || !isDatabaseId(item.id)) return;
  const { error } = await db.from("cart_items").upsert(
    { user_id: currentUser.id, product_id: item.id, quantity: item.quantity },
    { onConflict: "user_id,product_id" },
  );
  if (error) reportError("Could not save your cart", error);
}

async function loadAccountData() {
  if (!db || !currentUser) return;
  const [cartResult, wishlistResult] = await Promise.all([
    db.from("cart_items").select("product_id,quantity,products!inner(id,name,price,image_url,category)").eq("user_id", currentUser.id),
    db.from("wishlist_items").select("product_id,products!inner(id,name,price,image_url,category)").eq("user_id", currentUser.id),
  ]);
  if (cartResult.error) reportError("Could not load your saved cart", cartResult.error);
  if (wishlistResult.error) reportError("Could not load your wishlist", wishlistResult.error);

  if (!cartResult.error) {
    const savedItems = cartResult.data.map(({ product_id, quantity, products }) => ({
      id: product_id,
      image: products.image_url,
      titleName: products.name,
      priceNumber: Number(products.price),
      category: products.category,
      quantity,
    }));
    for (const localItem of carts.filter((item) => isDatabaseId(item.id))) {
      if (!savedItems.some((item) => item.id === localItem.id)) {
        await persistCartItem(localItem);
        savedItems.push(localItem);
      }
    }
    const localOnlyItems = carts.filter((item) => !isDatabaseId(item.id));
    carts = [...savedItems, ...localOnlyItems];
    updateCartUI();
  }

  if (!wishlistResult.error) {
    const savedItems = wishlistResult.data.map(({ product_id, products }) => ({
      id: product_id,
      img: products.image_url,
      title: products.name,
      priceNumber: Number(products.price),
      category: products.category,
    }));
    for (const localItem of wishlistCart.filter((item) => isDatabaseId(item.id))) {
      if (!savedItems.some((item) => item.id === localItem.id)) {
        const { error } = await db.from("wishlist_items").upsert({
          user_id: currentUser.id,
          product_id: localItem.id,
        }, { onConflict: "user_id,product_id" });
        if (error) reportError("Could not save your wishlist", error);
        else savedItems.push(localItem);
      }
    }
    wishlistCart = [
      ...savedItems,
      ...wishlistCart.filter((item) => !isDatabaseId(item.id)),
    ];
    updateWishlistUI();
  }
}

function renderAccount(session) {
  const header = document.querySelector(".hee");
  if (!header || document.querySelector(".account-status")) return;
  const wrapper = document.createElement("div");
  wrapper.className = "account-status";
  wrapper.style.cssText = "display:flex;align-items:center;gap:10px";
  if (session?.user) {
    const label = document.createElement("span");
    label.textContent = session.user.email || "Account";
    const logout = document.createElement("button");
    logout.type = "button";
    logout.textContent = "Log out";
    logout.addEventListener("click", async () => {
      const { error } = await db.auth.signOut();
      if (error) reportError("Could not sign out", error);
      else window.location.href = "index.html";
    });
    wrapper.append(label, logout);
  } else {
    const link = document.createElement("a");
    link.href = "./login.html";
    link.textContent = "Sign in";
    wrapper.append(link);
  }
  header.append(wrapper);
}

async function handleSession(session) {
  const previousUserId = currentUser?.id;
  const nextUserId = session?.user?.id;
  if (previousUserId && nextUserId && previousUserId !== nextUserId) {
    carts = [];
    wishlistCart = [];
  }
  currentUser = session?.user || null;
  document.querySelector(".account-status")?.remove();
  renderAccount(session);
  const checkoutPath = /\/(shopping|payment|review)\.html$/i.test(window.location.pathname);
  if (!currentUser && checkoutPath) {
    const nextPath = `${window.location.pathname.split("/").pop()}`;
    localStorage.setItem("returnAfterLogin", nextPath);
    const callback = new URL("./login.html", window.location.href);
    callback.searchParams.set("next", nextPath);
    window.location.replace(callback.toString());
    return;
  }
  if (currentUser) {
    await loadAccountData();
  } else {
    carts = readStored("carts");
    wishlistCart = readStored("wishlistCart");
    updateCartUI();
    updateWishlistUI();
  }
}

async function setupAuthentication() {
  const authForm = document.getElementById("authForm");
  const modeTabs = [...document.querySelectorAll("[data-auth-mode]")];
  const fullNameField = document.getElementById("fullNameField");
  const fullNameInput = document.getElementById("full-name");
  const passwordField = document.getElementById("password")?.closest(".auth-field");
  const passwordInput = document.getElementById("password");
  const confirmPasswordField = document.getElementById("confirmPasswordField");
  const confirmPasswordInput = document.getElementById("confirm-password");
  const passwordHint = document.getElementById("passwordHint");
  const submitButton = document.getElementById("authSubmit");
  const togglePassword = document.getElementById("togglePassword");
  const resendButton = document.getElementById("resendConfirmation");
  const forgotPasswordButton = document.getElementById("forgotPassword");
  const authTabs = document.getElementById("authTabs");
  const emailInput = document.getElementById("email");
  const initialMode = new URLSearchParams(window.location.search).get("mode");
  let authMode = initialMode === "update" ? "update" : "signin";
  const message = document.getElementById("message");

  const setAuthMessage = (text, isError = false) => {
    if (!text) {
      if (resendButton) resendButton.hidden = true;
    }
    if (message) {
      message.textContent = text;
      message.style.color = isError ? "red" : "green";
    } else {
      showMessage(text, isError);
    }
  };

  const isEmailRateLimitError = (error) =>
    /rate.?limit|too many requests/i.test(
      `${error.code || ""} ${error.message || ""}`,
    );

  const emailRateLimitMessage =
    "Supabase has temporarily limited confirmation emails after too many requests. Wait before trying again. If you already created an account, sign in instead.";

  const setAuthMode = (mode) => {
    authMode = mode;
    const signingUp = mode === "signup";
    const resetting = mode === "reset";
    const updatingPassword = mode === "update";
    const hasTabs = mode === "signin" || signingUp;
    if (fullNameField) fullNameField.hidden = !signingUp;
    if (fullNameInput) fullNameInput.required = signingUp;
    if (passwordField) passwordField.hidden = resetting;
    if (passwordInput) {
      passwordInput.required = !resetting;
      passwordInput.autocomplete = signingUp || updatingPassword ? "new-password" : "current-password";
      passwordInput.minLength = signingUp || updatingPassword ? 6 : 0;
    }
    if (confirmPasswordField) confirmPasswordField.hidden = !updatingPassword;
    if (confirmPasswordInput) confirmPasswordInput.required = updatingPassword;
    if (passwordHint) passwordHint.hidden = !(signingUp || updatingPassword);
    if (authTabs) authTabs.hidden = !hasTabs;
    if (forgotPasswordButton) forgotPasswordButton.hidden = mode !== "signin";
    if (submitButton) {
      submitButton.textContent = signingUp
        ? "Create account"
        : resetting
          ? "Send reset link"
          : updatingPassword
            ? "Save new password"
            : "Sign in";
    }
    document.getElementById("auth-title")?.replaceChildren(
      document.createTextNode(
        signingUp
          ? "Create your account"
          : resetting
            ? "Reset your password"
            : updatingPassword
              ? "Choose a new password"
              : "Welcome back",
      ),
    );
    const description = document.getElementById("auth-description");
    if (description) {
      description.textContent = signingUp
        ? "Create an account to save your cart and place your order."
        : resetting
          ? "Enter your account email and we’ll send you a secure password reset link."
          : updatingPassword
            ? "Choose a new password with at least 6 characters."
            : "Sign in to continue to checkout. You can shop without an account.";
    }
    modeTabs.forEach((tab) => {
      const active = tab.dataset.authMode === mode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    setAuthMessage("");
  };

  setAuthMode(authMode);

  const showConfirmationHelp = () => {
    setAuthMessage(
      "Your email hasn’t been confirmed yet. Open the latest confirmation email, then sign in again. If it didn’t arrive, resend it below.",
      true,
    );
    if (resendButton) resendButton.hidden = false;
  };

  modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode));
  });

  resendButton?.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    if (!email || !emailInput.validity.valid) {
      setAuthMessage("Enter the email address you registered with, then try again.", true);
      emailInput.focus();
      return;
    }
    const emailRedirectTo = getAuthRedirectUrl("signin");
    if (!emailRedirectTo) {
      setAuthMessage("Open this store from its http://localhost or https:// address to receive a working confirmation link.", true);
      return;
    }

    resendButton.disabled = true;
    resendButton.textContent = "Sending…";
    try {
      const { error } = await db.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo },
      });
      if (error) throw error;
      resendButton.hidden = true;
      setAuthMessage(
        `If ${email} has an unconfirmed account, a new confirmation email is on its way. Check your inbox and spam folder.`,
      );
    } catch (error) {
      setAuthMessage(
        isEmailRateLimitError(error)
          ? emailRateLimitMessage
          : error.message || "We couldn't resend the confirmation email. Please try again later.",
        true,
      );
      if (resendButton) resendButton.hidden = false;
    } finally {
      resendButton.disabled = false;
      resendButton.textContent = "Resend confirmation email";
    }
  });

  togglePassword?.addEventListener("click", () => {
    const isVisible = passwordInput.type === "text";
    passwordInput.type = isVisible ? "password" : "text";
    togglePassword.textContent = isVisible ? "Show" : "Hide";
    togglePassword.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
    togglePassword.setAttribute("aria-pressed", String(!isVisible));
  });

  forgotPasswordButton?.addEventListener("click", () => {
    setAuthMode("reset");
    emailInput.focus();
  });

  authForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;
    if (!db) {
      setAuthMessage("Connect your Supabase project before creating an account.", true);
      return;
    }

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (
      ["signup", "reset", "update"].includes(authMode) &&
      !getAuthRedirectUrl(authMode === "update" ? "update" : "signin")
    ) {
      setAuthMessage("Open this store from its http://localhost or https:// address to complete account verification securely.", true);
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = authMode === "signup"
      ? "Creating account…"
      : authMode === "reset"
        ? "Sending reset link…"
        : authMode === "update"
          ? "Saving password…"
          : "Signing in…";
    setAuthMessage("");

    try {
      if (authMode === "signup") {
        const fullName = fullNameInput.value.trim();
        const { data, error } = await db.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
            emailRedirectTo: getAuthRedirectUrl("signin"),
          },
        });
        if (error) throw error;
        if (data.session) {
          setAuthMessage("Your account is ready. Taking you back to checkout…");
          goToPostAuthPath();
        } else {
          setAuthMode("signin");
          emailInput.value = email;
          showConfirmationHelp();
        }
      } else if (authMode === "reset") {
        const { error } = await db.auth.resetPasswordForEmail(email, {
          redirectTo: getAuthRedirectUrl("update"),
        });
        if (error) throw error;
        setAuthMessage("If an account exists for that email, a password reset link is on its way. Check your inbox and spam folder.");
      } else if (authMode === "update") {
        if (password !== confirmPasswordInput.value) {
          setAuthMessage("Those passwords don’t match. Please try again.", true);
          confirmPasswordInput.focus();
          return;
        }
        const { error } = await db.auth.updateUser({ password });
        if (error) throw error;
        setAuthMessage("Your password has been updated. Taking you back to the store…");
        window.setTimeout(goToPostAuthPath, 900);
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        goToPostAuthPath();
      }
    } catch (error) {
      const errorMessage = error.message || "";
      const invalidCredentials =
        authMode === "signin" &&
        /invalid login credentials|email not found|user not found/i.test(errorMessage);
      const emailNeedsConfirmation =
        authMode === "signin" &&
        (error.code === "email_not_confirmed" ||
          /email not confirmed|email address.*not confirmed/i.test(errorMessage));
      if (emailNeedsConfirmation) {
        showConfirmationHelp();
        return;
      }
      setAuthMessage(
        invalidCredentials
          ? "We couldn't sign you in with those details. If this is your first time here, choose Create account. Otherwise, check your email and password."
          : isEmailRateLimitError(error) &&
              ["signup", "reset"].includes(authMode)
            ? emailRateLimitMessage
            : errorMessage || "We couldn't complete that request. Please try again.",
        true,
      );
    } finally {
      submitButton.disabled = false;
      if (authMode === "signup") submitButton.textContent = "Create account";
      else if (authMode === "reset") submitButton.textContent = "Send reset link";
      else if (authMode === "update") submitButton.textContent = "Save new password";
      else submitButton.textContent = "Sign in";
    }
  });

  if (!db) {
    if (authForm) {
      setAuthMessage(
        window.location.protocol === "file:"
          ? "This page is opened as a local file. Run the store on http://localhost for account registration and email links to work."
          : "Connect a Supabase project in supabase-config.js to use accounts.",
        true,
      );
    }
    const checkoutPath = /\/(shopping|payment|review)\.html$/i.test(window.location.pathname);
    if (checkoutPath) {
      const nextPath = window.location.pathname.split("/").pop();
      localStorage.setItem("returnAfterLogin", nextPath);
      const callback = new URL("./login.html", window.location.href);
      callback.searchParams.set("next", nextPath);
      window.location.replace(callback.toString());
    }
    return;
  }

  const { data, error } = await db.auth.getSession();
  if (error) reportError("Could not restore your sign-in session", error);
  await handleSession(data?.session);
  if (initialMode === "update" && !data?.session) {
    setAuthMode("signin");
    setAuthMessage("This password reset link is invalid or has expired. Request a new reset link and try again.", true);
  }
  if (
    data?.session?.user &&
    /\/login\.html$/i.test(window.location.pathname) &&
    initialMode !== "update"
  ) {
    goToPostAuthPath();
    return;
  }
  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") setAuthMode("update");
    void handleSession(session);
  });
}

document.addEventListener("click", async (event) => {
  const addButton = event.target.closest(".Add-to-cart");
  if (addButton) {
    const card = addButton.closest(".product-card");
    if (!card) return;
    const price = card.querySelector("h2")?.textContent || "";
    const item = {
      id: card.dataset.productId || card.id,
      image: card.querySelector("img")?.src || "",
      titleName: card.querySelector("h1")?.textContent || "Product",
      priceNumber: Number(price.replace(/[^0-9.]/g, "")) || 0,
      category: card.querySelector("p")?.textContent || "Product",
      quantity: 1,
    };
    const existing = carts.find((cartItem) => cartItem.id === item.id);
    if (existing && existing.quantity >= 99) {
      showMessage("You can add up to 99 of one product.", true);
      return;
    }
    if (existing) existing.quantity += 1;
    else carts.push(item);
    updateCartUI();
    const updatedItem = carts.find((cartItem) => cartItem.id === item.id);
    await persistCartItem(updatedItem);
    return;
  }

  const heart = event.target.closest(".product-card .fa-heart");
  if (heart) {
    const card = heart.closest(".product-card");
    const id = card.dataset.productId || card.id;
    const existingIndex = wishlistCart.findIndex((item) => item.id === id);
    if (existingIndex >= 0) {
      wishlistCart.splice(existingIndex, 1);
      if (db && currentUser && isDatabaseId(id)) {
        const { error } = await db.from("wishlist_items").delete()
          .eq("user_id", currentUser.id).eq("product_id", id);
        if (error) reportError("Could not update your wishlist", error);
      }
    } else {
      const item = {
        id,
        title: card.querySelector("h1")?.textContent || "Product",
        img: card.querySelector("img")?.src || "",
        priceNumber: Number((card.querySelector("h2")?.textContent || "").replace(/[^0-9.]/g, "")) || 0,
        category: card.querySelector("p")?.textContent || "Product",
      };
      wishlistCart.push(item);
      if (db && currentUser && isDatabaseId(id)) {
        const { error } = await db.from("wishlist_items").upsert(
          { user_id: currentUser.id, product_id: id },
          { onConflict: "user_id,product_id" },
        );
        if (error) reportError("Could not save your wishlist", error);
      } else if (db && !currentUser) {
        showMessage("Sign in to sync your wishlist across devices.");
      }
    }
    updateWishlistUI();
    return;
  }

  const cartButton = event.target.closest(".cart-item button[data-index]");
  if (cartButton) {
    const index = Number(cartButton.dataset.index);
    const item = carts[index];
    if (!item) return;
    if (cartButton.classList.contains("plus")) {
      if (item.quantity >= 99) {
        showMessage("You can add up to 99 of one product.", true);
        return;
      }
      item.quantity += 1;
    }
    else if (cartButton.classList.contains("minus")) item.quantity = Math.max(1, item.quantity - 1);
    else if (cartButton.classList.contains("remove")) {
      carts.splice(index, 1);
      if (db && currentUser && isDatabaseId(item.id)) {
        const { error } = await db.from("cart_items").delete()
          .eq("user_id", currentUser.id).eq("product_id", item.id);
        if (error) reportError("Could not remove the item from your saved cart", error);
      }
      updateCartUI();
      return;
    }
    updateCartUI();
    await persistCartItem(item);
    updateShippingSummary();
    return;
  }

  const removeWish = event.target.closest(".iconss");
  if (removeWish) {
    const item = wishlistCart[Number(removeWish.dataset.index)];
    if (!item) return;
    wishlistCart = wishlistCart.filter((entry) => entry.id !== item.id);
    if (db && currentUser && isDatabaseId(item.id)) {
      const { error } = await db.from("wishlist_items").delete()
        .eq("user_id", currentUser.id).eq("product_id", item.id);
      if (error) reportError("Could not remove the item from your wishlist", error);
    }
    updateWishlistUI();
    return;
  }

  const wishlistAdd = event.target.closest(".wishlist-add");
  if (wishlistAdd) {
    const item = wishlistCart[Number(wishlistAdd.dataset.index)];
    if (!item) return;
    const cartItem = {
      id: item.id,
      image: item.img,
      titleName: item.title,
      priceNumber: item.priceNumber,
      category: item.category,
      quantity: 1,
    };
    const existing = carts.find((entry) => entry.id === item.id);
    if (existing && existing.quantity >= 99) {
      showMessage("You can add up to 99 of one product.", true);
      return;
    }
    if (existing) existing.quantity += 1;
    else carts.push(cartItem);
    updateCartUI();
    await persistCartItem(carts.find((entry) => entry.id === item.id));
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "shippingForm") {
    event.preventDefault();
    const details = Object.fromEntries(new FormData(event.target));
    sessionStorage.setItem("shippingForm", JSON.stringify(details));
    window.location.href = event.target.getAttribute("action") || "payment.html";
  }

  if (event.target.id === "paymentForm") {
    event.preventDefault();
    const paymentMethod = new FormData(event.target).get("payment-method");
    sessionStorage.setItem("paymentMethod", paymentMethod || "cash_on_delivery");
    window.location.href = event.target.getAttribute("action") || "review.html";
  }
});

const placeOrderButton = document.getElementById("placeOrderBtn");
if (placeOrderButton) {
  placeOrderButton.addEventListener("click", async (event) => {
    event.preventDefault();
    if (!db) return showMessage("Connect Supabase before placing an order.", true);
    if (!currentUser) {
      localStorage.setItem("returnAfterLogin", "review.html");
      const callback = new URL("./login.html", window.location.href);
      callback.searchParams.set("next", "review.html");
      window.location.href = callback.toString();
      return;
    }
    if (carts.some((item) => !isDatabaseId(item.id))) {
      return showMessage("Some cart items are from the offline catalog. Remove them and add current Supabase products before ordering.", true);
    }
    const shippingAddress = JSON.parse(sessionStorage.getItem("shippingForm") || "{}");
    const { data, error } = await db.rpc("place_order", {
      p_shipping_address: {
        ...shippingAddress,
        payment_method: sessionStorage.getItem("paymentMethod") || "cash_on_delivery",
      },
    });
    if (error) return reportError("Could not place your order", error);
    sessionStorage.setItem("lastOrderId", data);
    carts = [];
    saveCart();
    updateCartUI();
    window.location.href = "placeorder.html";
  });
}

const storedOrderId = sessionStorage.getItem("lastOrderId");
const orderConfirmation = document.getElementById("orderConfirmation");
if (orderConfirmation && storedOrderId) {
  orderConfirmation.textContent = `Your order reference is ${storedOrderId}.`;
}

updateCartUI();
updateWishlistUI();
updateShippingSummary();
void loadProducts().catch((error) => reportError("Could not load products", error));
void setupAuthentication().catch((error) => reportError("Could not initialize accounts", error));
