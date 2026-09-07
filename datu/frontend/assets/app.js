(function () {
  "use strict";

  const priorityText = {
    urgent_important: "紧急重要",
    important_not_urgent: "重要不紧急",
    urgent_not_important: "紧急不重要",
    normal: "常规"
  };

  const priorityColor = {
    urgent_important: "#d43f4c",
    important_not_urgent: "#147c9e",
    urgent_not_important: "#c77618",
    normal: "#64777d"
  };

  const statusText = {
    normal: "正常",
    attention: "需关注",
    stuck: "卡住",
    not_started: "未开始",
    in_progress: "进行中",
    completed: "已完成",
    done: "已完成",
    blocked: "卡住"
  };

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function monday() {
    const value = new Date();
    value.setDate(value.getDate() - ((value.getDay() + 6) % 7));
    return value.toISOString().slice(0, 10);
  }

  function formatDate(value) {
    if (!value) return "";
    const parsed = new Date(`${value}T00:00:00`);
    return `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
  }

  async function request(path, method = "GET", body) {
    const response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await response.clone().json(); } catch (_) { data = {}; }
    if (response.status === 401 && !path.includes("/api/login")) {
      location.href = "/datu/index.html";
      throw new Error("请重新登录");
    }
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  const AppShell = {
    name: "AppShell",
    props: {
      active: { type: String, default: "" },
      activeCategoryId: { type: [Number, String], default: null },
      user: { type: Object, default: null },
      categories: { type: Array, default: () => [] }
    },
    data() {
      return { collapsed: false, mobileOpen: false };
    },
    methods: {
      toggleMobile() { this.mobileOpen = !this.mobileOpen; },
      toggleCollapsed() { this.collapsed = !this.collapsed; },
      async logout() {
        try { await request("/datu/api/logout", "POST", {}); } finally { location.href = "/datu/index.html"; }
      }
    },
    template: `
      <div class="app-shell">
        <aside class="sidebar" :class="{ collapsed, 'mobile-open': mobileOpen }">
          <div class="side-logo">
            <div class="brand-mark">土</div>
            <div v-if="!collapsed"><strong>大土工作台</strong><small>{{ user?.displayName || user?.username || '' }}</small></div>
          </div>
          <nav class="side-nav">
            <a href="/datu/tasks.html" :class="{ active: active === 'tasks' }"><span>今天待办</span></a>
            <a href="/datu/categories.html" :class="{ active: active === 'categories' }"><span>工作分类</span></a>
            <template v-for="category in categories" :key="category.id">
              <a class="sub" :href="'/datu/category.html?id=' + category.id" :class="{ active: active === 'category' && Number(activeCategoryId) === category.id }">
                <span>{{ category.name }}</span>
              </a>
            </template>
            <div v-if="!categories.length" class="empty">暂无分类</div>
            <a href="/datu/review.html" :class="{ active: active === 'review' }"><span>每周复盘</span></a>
            <a href="/datu/ideas.html" :class="{ active: active === 'ideas' }"><span>灵感速记</span></a>
          </nav>
          <div class="side-footer">
            <button @click="toggleCollapsed"><span>{{ collapsed ? '展开' : '折叠' }}</span></button>
            <button @click="logout"><span>退出登录</span></button>
          </div>
        </aside>
        <main class="main">
          <header class="topbar">
            <button class="icon-btn" @click="toggleMobile" aria-label="打开菜单">☰</button>
            <h1><slot name="title"></slot></h1>
            <div class="topbar-user">{{ user?.displayName || user?.username }}</div>
          </header>
          <slot name="content"></slot>
        </main>
      </div>
    `
  };

  const RichEditor = {
    name: "RichEditor",
    props: { modelValue: { type: String, default: "" } },
    emits: ["update:modelValue"],
    data() {
      return { hasWangEditor: Boolean(window.wangEditor), editor: null };
    },
    watch: {
      modelValue(value) {
        if (this.editor && value !== this.editor.getHtml()) this.editor.setHtml(value || "");
      }
    },
    mounted() {
      if (!this.hasWangEditor) {
        this.$refs.fallback.innerHTML = this.modelValue || "";
        return;
      }
      this.editor = window.wangEditor.createEditor(this.$refs.editor, { html: this.modelValue || "" });
      this.editor.on("change", () => this.$emit("update:modelValue", this.editor.getHtml()));
    },
    beforeUnmount() {
      if (this.editor) this.editor.destroy();
    },
    methods: {
      onFallbackInput(event) {
        this.$emit("update:modelValue", event.target.innerHTML);
      }
    },
    template: `
      <div>
        <div ref="editor" class="editor-box"></div>
        <div v-if="!hasWangEditor" ref="fallback" class="fallback-editor" contenteditable="true" @input="onFallbackInput"></div>
      </div>
    `
  };

  async function mountPage({ active, setup }) {
    const shellState = Vue.reactive({ user: null, categories: [], loaded: false });
    const userBindings = setup ? setup() : {};

    const app = Vue.createApp({
      setup() {
        Vue.onMounted(async () => {
          try {
            shellState.user = await request("/datu/api/me");
            const workspace = await request("/datu/api/workspace");
            shellState.categories = workspace.categories || [];
            shellState.loaded = true;
          } catch (_) {}
        });
        return { ...Vue.toRefs(shellState), ...userBindings };
      }
    });

    app.component("app-shell", AppShell);
    app.component("rich-editor", RichEditor);
    app.mount("#app");
    return app;
  }

  function showToast(message, isError = false) {
    const node = document.createElement("div");
    node.className = `toast${isError ? " error" : ""}`;
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 2400);
  }

  window.Datu = {
    priorityText,
    priorityColor,
    statusText,
    today,
    monday,
    formatDate,
    request,
    mountPage,
    showToast
  };
})();
