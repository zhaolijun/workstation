(function () {
  "use strict";

  const BASE = "/datu";
  const priorityText = {
    urgent_important: "紧急重要",
    important_not_urgent: "重要不紧急",
    urgent_not_important: "紧急不重要",
    normal: "常规"
  };
  const statusText = {
    normal: "正常", attention: "需关注", stuck: "卡住",
    not_started: "未开始", in_progress: "进行中", completed: "已完成",
    done: "已完成", blocked: "卡住"
  };
  const menu = [
    { path: "/tasks", label: "今天待办", icon: "M4 12l5 5 11-11" },
    { path: "/team", label: "团队建设", icon: "M8 11a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6 3 3 0 000 6zM2 20c0-3.3 2.7-6 6-6s6 2.7 6 6m2-6c3.3 0 6 2.7 6 6" },
    { path: "/projects", label: "项目管理", icon: "M3 7h7l2 2h9v10H3z" },
    { path: "/review", label: "每周复盘", icon: "M5 20V10m7 10V4m7 16v-7" },
    { path: "/ideas", label: "灵感速记", icon: "M12 3a6 6 0 013 11v3H9v-3a6 6 0 013-11zM9 21h6" }
  ];

  const RichEditor = {
    name: "RichEditor",
    props: { modelValue: { type: String, default: "" } },
    emits: ["update:modelValue"],
    data() { return { hasWangEditor: Boolean(window.wangEditor), editor: null }; },
    watch: {
      modelValue(value) { if (this.editor && value !== this.editor.getHtml()) this.editor.setHtml(value || ""); }
    },
    mounted() {
      if (!this.hasWangEditor) {
        this.$refs.fallback.innerHTML = this.modelValue || "";
        return;
      }
      this.editor = window.wangEditor.createEditor(this.$refs.editor, { html: this.modelValue || "" });
      window.wangEditor.createToolbar({ editor: this.editor, selector: this.$refs.toolbar });
      this.editor.on("change", () => this.$emit("update:modelValue", this.editor.getHtml()));
    },
    beforeUnmount() { if (this.editor) this.editor.destroy(); },
    methods: {
      onFallbackInput(event) { this.$emit("update:modelValue", event.target.innerHTML); },
      exec(command) { document.execCommand(command, false, null); this.$refs.fallback.focus(); this.onFallbackInput({ target: this.$refs.fallback }); },
      heading() { document.execCommand("formatBlock", false, "<h3>"); this.$refs.fallback.focus(); this.onFallbackInput({ target: this.$refs.fallback }); },
      clear() { this.$refs.fallback.innerHTML = ""; this.$emit("update:modelValue", ""); }
    },
    template: `
      <div class="rich-editor">
        <div v-if="!hasWangEditor" class="rich-toolbar">
          <button type="button" @click="exec('bold')"><strong>B</strong></button>
          <button type="button" @click="exec('italic')"><i>I</i></button>
          <button type="button" @click="exec('underline')"><u>U</u></button>
          <button type="button" @click="heading">H</button>
          <button type="button" @click="exec('insertUnorderedList')">列表</button>
          <button type="button" class="ghost" @click="clear">清空</button>
        </div>
        <div v-if="hasWangEditor" ref="toolbar" class="editor-toolbar"></div>
        <div v-if="hasWangEditor" ref="editor" class="editor-box"></div>
        <div v-else ref="fallback" class="rich-body" contenteditable="true" @input="onFallbackInput"></div>
      </div>
    `
  };

  const TasksPage = {
    components: { RichEditor },
    props: ["workspace"],
    template: "#tasks-page-template",
    data() {
      const today = this.workspace ? this.workspace.today : new Date().toISOString().slice(0, 10);
      return {
        form: { title: "", content: "", priority: "important_not_urgent", dueDate: today, projectId: "", teamGoalId: "", blocked: false },
        expanded: null,
        source: "all"
      };
    },
    watch: {
      form: { handler(value) { localStorage.setItem("datu.draft.task", JSON.stringify(value)); }, deep: true }
    },
    created() {
      const draft = localStorage.getItem("datu.draft.task");
      if (draft) this.form = { ...this.form, ...JSON.parse(draft) };
      this.form.dueDate = this.form.dueDate || this.workspace.today;
    },
    computed: {
      sourceTabs() { return [{ key: "all", label: "全部" }, { key: "manual", label: "手工" }, { key: "team", label: "团队" }, { key: "project", label: "项目" }]; },
      sourceTasks() {
        return this.workspace.tasks.filter(task => {
          if (this.source === "team") return !!task.team_goal_id;
          if (this.source === "project") return !!task.project_id;
          if (this.source === "manual") return !task.project_id && !task.team_goal_id;
          return true;
        });
      },
      currentTasks() { const today = this.workspace.today; return this.sourceTasks.filter(task => !task.done && task.due_date <= today); },
      futureGroups() {
        const today = this.workspace.today, result = [];
        this.sourceTasks.filter(task => !task.done && task.due_date > today).sort((a, b) => a.due_date.localeCompare(b.due_date)).forEach(task => {
          let group = result.find(row => row.date === task.due_date);
          if (!group) { group = { date: task.due_date, items: [] }; result.push(group); }
          group.items.push(task);
        });
        return result;
      },
      doneTasks() { return this.sourceTasks.filter(task => task.done); },
      completion() {
        const total = this.workspace.tasks.length;
        return total ? Math.round(this.workspace.tasks.filter(item => item.done).length * 100 / total) : 0;
      }
    },
    methods: {
      sourceLabel(task) { return task.team_goal_id ? "团队" : task.project_id ? "项目" : "手工"; },
      goalName(task) {
        if (task.team_goal_id) { const goal = this.workspace.teamGoals.find(item => item.id === task.team_goal_id); return goal ? goal.title : ""; }
        return "";
      },
      projectName(id) { const item = this.workspace.projects.find(row => row.id === id); return item ? item.name : ""; },
      priorityLabel(value) { return priorityText[value] || value; },
      formatDate(value) { return value ? value.slice(5).replace("-", "月") + "日" : ""; },
      taskDanger(task) { return task.blocked || task.overdue; },
      async create() {
        if (!this.form.title.trim()) return;
        await this.$root.call(BASE + "/api/tasks", "POST", { ...this.form });
        this.form = { title: "", content: "", priority: "important_not_urgent", dueDate: this.workspace.today, projectId: "", teamGoalId: "", blocked: false };
        localStorage.removeItem("datu.draft.task");
      },
      async toggle(task) { await this.$root.call(BASE + "/api/tasks/" + task.id, "PUT", { done: !task.done }); },
      async postpone(task) { await this.$root.call(BASE + "/api/tasks/" + task.id, "PUT", { postpone: true, postponedCount: task.postponed_count }); },
      async toggleBlocked(task) { await this.$root.call(BASE + "/api/tasks/" + task.id, "PUT", { blocked: !task.blocked }); },
      async remove(task) { if (confirm("删除「" + task.title + "」？")) await this.$root.call(BASE + "/api/tasks/" + task.id, "DELETE"); }
    }
  };

  const ProjectsPage = {
    components: { RichEditor },
    props: ["workspace"],
    data() {
      return {
        project: { name: "", description: "", status: "in_progress", startDate: "", dueDate: "" },
        editingId: null,
        task: { title: "", content: "", priority: "important_not_urgent", dueDate: "", projectId: "", blocked: false }
      };
    },
    computed: {
      current() { return this.workspace.projects.find(item => item.id === this.editingId) || null; },
      projectTasks() { return this.workspace.tasks.filter(item => item.project_id === this.editingId); }
    },
    methods: {
      resetProject() { this.project = { name: "", description: "", status: "in_progress", startDate: "", dueDate: "" }; this.editingId = null; },
      edit(project) {
        this.editingId = project.id;
        this.project = { name: project.name, description: project.description, status: project.status, startDate: project.start_date || "", dueDate: project.due_date || "" };
      },
      async save() {
        if (!this.project.name.trim()) return;
        if (this.editingId) await this.$root.call(`${BASE}/api/projects/${this.editingId}`, "PUT", this.project);
        else await this.$root.call(`${BASE}/api/projects`, "POST", this.project);
        this.resetProject();
      },
      async removeProject(project) { if (confirm(`删除项目「${project.name}」？`)) await this.$root.call(`${BASE}/api/projects/${project.id}`, "DELETE"); },
      async createTask() {
        if (!this.task.title.trim() || !this.editingId) return;
        await this.$root.call(`${BASE}/api/tasks`, "POST", { ...this.task, projectId: this.editingId, dueDate: this.task.dueDate || this.workspace.today });
        this.task = { title: "", content: "", priority: "important_not_urgent", dueDate: "", projectId: "", blocked: false };
      },
      async toggle(task) { await this.$root.call(`${BASE}/api/tasks/${task.id}`, "PUT", { done: !task.done }); },
      async removeTask(task) { await this.$root.call(`${BASE}/api/tasks/${task.id}`, "DELETE"); },
      percent(project) { return project.total_count ? Math.round(project.done_count * 100 / project.total_count) : 0; },
      priorityLabel(value) { return priorityText[value] || value; },
      statusLabel(value) { return statusText[value] || value; },
      formatDate(value) { return value ? value.slice(5).replace("-", "月") + "日" : ""; }
    },
    template: `
      <section class="route-view">
        <div class="section-grid">
          <article class="panel">
            <div class="panel-head"><h2>{{ editingId ? "编辑项目" : "新建项目" }}</h2><button v-if="editingId" class="link" @click="resetProject">切换为新建</button></div>
            <form class="form-grid" @submit.prevent="save">
              <label>项目名称<input v-model.trim="project.name" required></label>
              <label>状态<select v-model="project.status"><option value="not_started">未开始</option><option value="in_progress">进行中</option><option value="stuck">卡住</option><option value="completed">已完成</option></select></label>
              <label>开始日期<input v-model="project.startDate" type="date"></label>
              <label>目标完成<input v-model="project.dueDate" type="date"></label>
              <label class="span-2">项目介绍<textarea v-model="project.description" rows="4" placeholder="背景、目标、关键结果"></textarea></label>
              <button class="btn primary big span-2">{{ editingId ? "保存修改" : "创建项目" }}</button>
            </form>
          </article>
          <article class="panel">
            <div class="panel-head"><h2>项目进度</h2><span class="muted">{{ workspace.projects.length }} 个项目</span></div>
            <div v-if="!workspace.projects.length" class="empty">暂无项目</div>
            <div v-for="project in workspace.projects" :key="project.id" class="row-card" :class="{ active: project.id === editingId }" @click="edit(project)">
              <div class="row-head"><strong>{{ project.name }}</strong><span class="pill" :class="project.status">{{ statusLabel(project.status) }}</span></div>
              <div class="progress"><i :style="{ width: percent(project) + '%' }"></i></div>
              <div class="muted small-text">{{ project.done_count }}/{{ project.total_count }} 完成，目标 {{ formatDate(project.due_date) || "未设置" }}</div>
              <div class="actions"><button class="small" @click.stop="edit(project)">编辑</button><button class="small danger" @click.stop="removeProject(project)">删除</button></div>
            </div>
          </article>
        </div>
        <article v-if="current" class="panel">
          <div class="panel-head"><h2>{{ current.name }} · 任务分解</h2><span class="muted">{{ percent(current) }}% 完成</span></div>
          <form class="inline-form" @submit.prevent="createTask">
            <input v-model.trim="task.title" placeholder="新任务标题" required><input v-model="task.dueDate" type="date">
            <select v-model="task.priority"><option value="urgent_important">紧急重要</option><option value="important_not_urgent">重要不紧急</option><option value="urgent_not_important">紧急不重要</option><option value="normal">常规</option></select>
            <button class="btn primary">添加任务</button>
          </form>
          <div class="rich-margin"><div class="field-label">任务说明</div><rich-editor v-model="task.content"></rich-editor></div>
          <div v-if="!projectTasks.length" class="empty">这个项目还没有任务</div>
          <div v-for="task in projectTasks" :key="task.id" class="task" :class="{ done: task.done, red: task.blocked && !task.done }">
            <button class="check-btn" :class="{ on: task.done }" @click="toggle(task)">✓</button>
            <div class="task-body"><div class="task-title">{{ task.title }}</div><div class="task-meta"><span class="pill" :data-priority="task.priority">{{ priorityLabel(task.priority) }}</span><span>{{ formatDate(task.due_date) }}</span><span v-if="task.blocked" class="pill red">卡住</span></div></div>
            <div class="task-actions"><button class="small danger" @click="removeTask(task)">删除</button></div>
          </div>
        </article>
      </section>
    `
  };

  const TeamPage = {
    components: { RichEditor },
    props: ["workspace"],
    data() {
      return {
        goal: { title: "", period: "monthly", objectives: "", plan: "", dueDate: "", status: "in_progress" },
        goalId: null,
        progress: { goalId: "", weekStart: this.workspace ? this.workspace.weekStart : "", result: "", blockers: "", status: "in_progress" },
        member: { name: "", role: "", status: "normal", strengths: "", risks: "" }
      };
    },
    computed: {
      currentGoal() { return this.workspace.teamGoals.find(item => item.id === this.goalId) || null; },
      memberStatus() {
        const result = { normal: 0, attention: 0, stuck: 0 };
        this.workspace.teamMembers.forEach(item => { result[item.status] = (result[item.status] || 0) + 1; });
        return result;
      }
    },
    methods: {
      resetGoal() { this.goal = { title: "", period: "monthly", objectives: "", plan: "", dueDate: "", status: "in_progress" }; this.goalId = null; },
      editGoal(goal) { this.goalId = goal.id; this.goal = { title: goal.title, period: goal.period, objectives: goal.objectives, plan: goal.plan, dueDate: goal.due_date || "", status: goal.status }; },
      async saveGoal() {
        if (!this.goal.title.trim()) return;
        if (this.goalId) await this.$root.call(`${BASE}/api/team-goals/${this.goalId}`, "PUT", this.goal); else await this.$root.call(`${BASE}/api/team-goals`, "POST", this.goal);
        this.resetGoal();
      },
      async removeGoal(goal) { if (confirm(`删除目标「${goal.title}」？`)) await this.$root.call(`${BASE}/api/team-goals/${goal.id}`, "DELETE"); },
      async saveProgress() {
        if (!this.progress.goalId) return;
        await this.$root.call(`${BASE}/api/team-progress`, "POST", { ...this.progress, weekStart: this.progress.weekStart || this.workspace.weekStart });
        this.progress.result = ""; this.progress.blockers = "";
      },
      async removeProgress(row) { await this.$root.call(`${BASE}/api/team-progress/${row.id}`, "DELETE"); },
      async addMember() {
        if (!this.member.name.trim()) return;
        await this.$root.call(`${BASE}/api/team-members`, "POST", this.member);
        this.member = { name: "", role: "", status: "normal", strengths: "", risks: "" };
      },
      async removeMember(member) { if (confirm(`移除成员「${member.name}」？`)) await this.$root.call(`${BASE}/api/team-members/${member.id}`, "DELETE"); },
      percent(goal) { return goal.total_count ? Math.round(goal.done_count * 100 / goal.total_count) : 0; },
      statusLabel(value) { return statusText[value] || value; },
      periodLabel(value) { return value === "quarterly" ? "季度" : "月度"; }
    },
    template: `
      <section class="route-view">
        <div class="section-grid">
          <article class="panel">
            <div class="panel-head"><h2>{{ goalId ? "编辑团队目标" : "新建团队目标" }}</h2><button v-if="goalId" class="link" @click="resetGoal">切换为新建</button></div>
            <form class="form-grid" @submit.prevent="saveGoal">
              <label>目标名称<input v-model.trim="goal.title" required></label>
              <label>周期<select v-model="goal.period"><option value="monthly">月度</option><option value="quarterly">季度</option></select></label>
              <label>状态<select v-model="goal.status"><option value="in_progress">进行中</option><option value="stuck">卡住</option><option value="completed">已完成</option></select></label>
              <label>完成日期<input v-model="goal.dueDate" type="date"></label>
              <label class="span-2">目标说明<textarea v-model="goal.objectives" rows="3"></textarea></label>
              <label class="span-2">行动计划<textarea v-model="goal.plan" rows="3"></textarea></label>
              <button class="btn primary big span-2">{{ goalId ? "保存修改" : "创建目标" }}</button>
            </form>
          </article>
          <article class="panel">
            <div class="panel-head"><h2>团队目标</h2><span class="muted">月度 / 季度</span></div>
            <div v-if="!workspace.teamGoals.length" class="empty">暂无团队目标</div>
            <div v-for="goal in workspace.teamGoals" :key="goal.id" class="row-card" :class="{ active: goal.id === goalId }" @click="goalId = goal.id">
              <div class="row-head"><strong>{{ goal.title }}</strong><span class="pill">{{ periodLabel(goal.period) }}</span></div>
              <div class="progress"><i :style="{ width: percent(goal) + '%' }"></i></div>
              <div class="muted small-text">{{ goal.done_count }}/{{ goal.total_count }}，{{ statusLabel(goal.status) }}</div>
              <div class="actions"><button class="small" @click.stop="editGoal(goal)">编辑</button><button class="small danger" @click.stop="removeGoal(goal)">删除</button></div>
            </div>
          </article>
        </div>
        <div class="section-grid">
          <article class="panel">
            <div class="panel-head"><h2>每周完成记录</h2><span class="muted">{{ workspace.weekStart }} 开始</span></div>
            <form class="form-grid" @submit.prevent="saveProgress">
              <label>团队目标<select v-model="progress.goalId" required><option value="">请选择</option><option v-for="goal in workspace.teamGoals" :key="goal.id" :value="goal.id">{{ goal.title }}</option></select></label>
              <label>周开始<input v-model="progress.weekStart" type="date"></label>
              <label>状态<select v-model="progress.status"><option value="in_progress">进行中</option><option value="completed">已完成</option><option value="stuck">卡住</option></select></label>
              <label class="span-2">完成情况<textarea v-model="progress.result" rows="3"></textarea></label>
              <label class="span-2">卡点<textarea v-model="progress.blockers" rows="2"></textarea></label>
              <button class="btn primary big span-2">保存周记录</button>
            </form>
            <div v-for="row in workspace.teamProgress" :key="row.id" class="note-card">
              <div class="row-head"><strong>{{ workspace.teamGoals.find(g => g.id === row.goal_id)?.title || "目标" }}</strong><span>{{ row.week_start }}</span></div>
              <p>{{ row.result || "未填写完成情况" }}</p><p v-if="row.blockers" class="muted">卡点：{{ row.blockers }}</p>
              <div class="actions"><button class="small danger" @click="removeProgress(row)">删除</button></div>
            </div>
          </article>
          <article class="panel">
            <div class="panel-head"><h2>人员盘点</h2><span class="muted">{{ workspace.teamMembers.length }} 人</span></div>
            <form class="form-grid compact" @submit.prevent="addMember">
              <label>姓名<input v-model.trim="member.name" required></label><label>角色<input v-model.trim="member.role"></label>
              <label>状态<select v-model="member.status"><option value="normal">正常</option><option value="attention">需关注</option><option value="stuck">卡住</option></select></label>
              <label class="span-2">优势<textarea v-model="member.strengths" rows="2"></textarea></label>
              <label class="span-2">风险<textarea v-model="member.risks" rows="2"></textarea></label>
              <button class="btn primary">添加成员</button>
            </form>
            <div class="bar-list">
              <div class="bar-row"><span>正常</span><div><i :style="{ width: (memberStatus.normal || 0) * 20 + '%' }"></i></div><b>{{ memberStatus.normal || 0 }}</b></div>
              <div class="bar-row"><span>需关注</span><div><i style="background:#c77618" :style="{ width: (memberStatus.attention || 0) * 20 + '%' }"></i></div><b>{{ memberStatus.attention || 0 }}</b></div>
              <div class="bar-row"><span>卡住</span><div><i style="background:#d43f4c" :style="{ width: (memberStatus.stuck || 0) * 20 + '%' }"></i></div><b>{{ memberStatus.stuck || 0 }}</b></div>
            </div>
            <div v-for="member in workspace.teamMembers" :key="member.id" class="member-card">
              <div class="row-head"><strong>{{ member.name }}</strong><span class="pill" :class="member.status">{{ statusLabel(member.status) }}</span></div>
              <div class="muted">{{ member.role || "未设置角色" }}</div>
              <p v-if="member.strengths"><b>优势：</b>{{ member.strengths }}</p><p v-if="member.risks"><b>风险：</b>{{ member.risks }}</p>
              <div class="actions"><button class="small danger" @click="removeMember(member)">移除</button></div>
            </div>
          </article>
        </div>
      </section>
    `
  };

  const ReviewPage = {
    props: ["workspace"],
    computed: {
      doneTasks() { return this.workspace.tasks.filter(item => item.done && item.completed_at && item.completed_at.slice(0, 10) >= this.workspace.weekStart); },
      priorityStats() {
        const result = { urgent_important: 0, important_not_urgent: 0, urgent_not_important: 0, normal: 0 };
        this.doneTasks.forEach(item => { result[item.priority] = (result[item.priority] || 0) + 1; });
        return result;
      },
      energy() {
        const map = new Map();
        this.doneTasks.forEach(task => {
          const project = this.workspace.projects.find(item => item.id === task.project_id);
          const key = project ? project.name : "其他";
          map.set(key, (map.get(key) || 0) + 1);
        });
        this.workspace.projects.forEach(project => { if (!map.has(project.name)) map.set(project.name, 0); });
        return [...map.entries()].map(([name, count]) => ({ name, count }));
      },
      blockers() {
        const tasks = this.workspace.tasks.filter(item => !item.done && item.blocked).map(item => ({ title: item.title, detail: "任务已标记卡住", due: item.due_date }));
        const projects = this.workspace.projects.filter(item => item.status === "stuck").map(item => ({ title: item.name, detail: item.description || "项目卡住", due: item.due_date }));
        const team = this.workspace.teamProgress.filter(item => item.blockers).map(item => ({ title: item.week_start + " 周记录", detail: item.blockers, due: item.week_start }));
        return [...tasks, ...projects, ...team];
      },
      maxEnergy() { return Math.max(1, ...this.energy.map(item => item.count)); }
    },
    methods: {
      priorityLabel(value) { return priorityText[value] || value; },
      formatDate(value) { return value ? value.slice(5).replace("-", "月") + "日" : ""; }
    },
    template: `
      <section class="route-view">
        <div class="metric-grid">
          <article class="panel"><small>本周完成</small><strong>{{ doneTasks.length }}</strong><span>件事</span></article>
          <article class="panel"><small>进行中</small><strong>{{ workspace.tasks.filter(i => !i.done).length }}</strong><span>项任务</span></article>
          <article class="panel danger"><small>卡点</small><strong>{{ blockers.length }}</strong><span>条</span></article>
          <article class="panel"><small>项目</small><strong>{{ workspace.projects.length }}</strong><span>个</span></article>
        </div>
        <div class="section-grid">
          <article class="panel"><div class="panel-head"><h2>优先级分布</h2><span class="muted">{{ workspace.weekStart }} 起</span></div><div class="bar-list"><div v-for="(count, key) in priorityStats" :key="key" class="bar-row"><span>{{ priorityLabel(key) }}</span><div><i :style="{ width: (count / Math.max(1, doneTasks.length)) * 100 + '%' }"></i></div><b>{{ count }}</b></div></div></article>
          <article class="panel"><div class="panel-head"><h2>精力投入</h2><span class="muted">按项目</span></div><div class="bar-list"><div v-for="item in energy" :key="item.name" class="bar-row"><span>{{ item.name }}</span><div><i :style="{ width: (item.count / maxEnergy) * 100 + '%' }"></i></div><b>{{ item.count }}</b></div></div></article>
        </div>
        <article class="panel"><div class="panel-head"><h2>卡点汇总</h2><span class="muted">需要优先处理</span></div><div v-if="!blockers.length" class="empty">本周暂无卡点</div><div v-for="(item, index) in blockers" :key="index" class="blocker"><strong>{{ item.title }}</strong><p>{{ item.detail }}</p><span class="muted">{{ formatDate(item.due) }}</span></div></article>
      </section>
    `
  };

  const IdeasPage = {
    props: ["workspace"],
    data() { return { form: { title: "", content: "", tags: "" }, tag: "" }; },
    computed: {
      tags() {
        const set = new Set();
        this.workspace.ideas.forEach(idea => String(idea.tags || "").split(",").map(item => item.trim()).filter(Boolean).forEach(item => set.add(item)));
        return [...set];
      },
      list() { return this.workspace.ideas.filter(idea => !this.tag || String(idea.tags || "").split(",").map(item => item.trim()).includes(this.tag)); }
    },
    methods: {
      async create() { if (!this.form.content.trim()) return; await this.$root.call(`${BASE}/api/ideas`, "POST", this.form); this.form = { title: "", content: "", tags: "" }; },
      async remove(idea) { if (confirm("删除这条灵感？")) await this.$root.call(`${BASE}/api/ideas/${idea.id}`, "DELETE"); },
      toggleTag(value) { this.tag = this.tag === value ? "" : value; }
    },
    template: `
      <section class="route-view">
        <div class="section-grid">
          <article class="panel"><div class="panel-head"><h2>记录灵感</h2><span class="muted">随手保存</span></div>
            <form class="form-grid" @submit.prevent="create"><label class="span-2">标题<input v-model.trim="form.title" placeholder="可留空"></label><label class="span-2">内容<textarea v-model="form.content" rows="5" required></textarea></label><label class="span-2">标签<input v-model.trim="form.tags" placeholder="自动化,流程,工具"></label><button class="btn primary big span-2">保存灵感</button></form>
          </article>
          <article class="panel"><div class="panel-head"><h2>标签筛选</h2><button v-if="tag" class="link" @click="tag = ''">清除</button></div><div class="tag-cloud"><button v-for="item in tags" :key="item" class="tag" :class="{ active: tag === item }" @click="toggleTag(item)">{{ item }}</button><span v-if="!tags.length" class="empty">暂无标签</span></div></article>
        </div>
        <div class="idea-grid"><article v-for="idea in list" :key="idea.id" class="panel idea"><h3>{{ idea.title || idea.content.slice(0, 20) }}</h3><p>{{ idea.content }}</p><div class="tag-cloud"><button v-for="item in idea.tags.split(',')" :key="item" v-if="item.trim()" class="tag mini" @click="toggleTag(item.trim())">{{ item.trim() }}</button></div><div class="actions"><button class="small danger" @click="remove(idea)">删除</button></div></article></div>
        <div v-if="!list.length" class="empty panel">暂无灵感</div>
      </section>
    `
  };

  const router = VueRouter.createRouter({
    history: VueRouter.createWebHashHistory(`${BASE}/`),
    routes: [
      { path: "/", redirect: "/tasks" },
      { path: "/tasks", component: TasksPage },
      { path: "/team", component: TeamPage },
      { path: "/projects", component: ProjectsPage },
      { path: "/review", component: ReviewPage },
      { path: "/ideas", component: IdeasPage },
      { path: "/:pathMatch(.*)*", redirect: "/tasks" }
    ]
  });

  const App = {
    data() {
      return {
        workspace: null, loading: true, saving: false, error: "", toast: "",
        login: { username: "", password: "" }, loginError: "",
        collapsed: localStorage.getItem("datu.sidebar") === "collapsed",
        mobileOpen: false, menu
      };
    },
    computed: {
      risks() {
        if (!this.workspace) return [];
        const today = this.workspace.today, list = [];
        this.workspace.tasks.forEach(task => {
          if (!task.done && (task.blocked || task.due_date <= today)) list.push({ type: "任务", title: task.title, detail: task.blocked ? "任务卡住" : "已逾期或今天到期", danger: task.blocked || task.due_date < today });
        });
        this.workspace.projects.forEach(project => { if (project.status === "stuck") list.push({ type: "项目", title: project.name, detail: project.description || "项目卡住", danger: true }); });
        this.workspace.teamGoals.forEach(goal => { if (goal.status === "stuck") list.push({ type: "团队目标", title: goal.title, detail: "目标卡住", danger: true }); });
        return list.sort((a, b) => Number(b.danger) - Number(a.danger)).slice(0, 6);
      },
      routeTitle() { const item = this.menu.find(row => row.path === this.$route.path); return item ? item.label : "大土工作台"; }
    },
    async mounted() {
      await this.load();
      router.afterEach(() => { this.mobileOpen = false; window.scrollTo({ top: 0, behavior: "smooth" }); });
    },
    methods: {
      async load() {
        this.loading = true;
        try {
          const response = await fetch(`${BASE}/api/workspace`, { credentials: "same-origin" });
          if (!response.ok) throw new Error("请先登录");
          this.workspace = await response.json(); this.error = "";
        } catch (_) { this.workspace = null; } finally { this.loading = false; }
      },
      async signIn() {
        this.loginError = "";
        try {
          const response = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.login) });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "登录失败");
          await this.load();
        } catch (err) { this.loginError = err.message; }
      },
      async logout() {
        try { await fetch(`${BASE}/api/logout`, { method: "POST" }); } finally { this.workspace = null; }
      },
      async call(path, method = "GET", body) {
        this.saving = true; this.error = ""; this.toast = "";
        try {
          const response = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "保存失败");
          if (data.workspace) this.workspace = data.workspace; else await this.load();
          this.toast = "已保存";
        } catch (err) { this.error = err.message; if (err.message === "请先登录") this.workspace = null; }
        finally { this.saving = false; setTimeout(() => { this.toast = ""; }, 1600); }
      },
      toggleSidebar() {
        this.collapsed = !this.collapsed;
        localStorage.setItem("datu.sidebar", this.collapsed ? "collapsed" : "expanded");
      }
    },
    template: `
      <div v-if="loading" class="splash"><div class="brand-mark">土</div><p>正在加载工作台…</p></div>
      <div v-else-if="!workspace" class="login-page">
        <form class="login-card" @submit.prevent="signIn">
          <div class="brand-mark">土</div><h1>大土工作台</h1><p class="muted">专注待办、团队与项目推进</p>
          <label>用户名<input v-model.trim="login.username" autocomplete="username" required></label>
          <label>密码<input v-model="login.password" type="password" autocomplete="current-password" required></label>
          <button class="btn primary big">进入工作台</button>
          <p v-if="loginError" class="error">{{ loginError }}</p>
        </form>
      </div>
      <div v-else class="app-shell">
        <div class="mobile-mask" :class="{ open: mobileOpen }" @click="mobileOpen = false"></div>
        <aside class="sidebar" :class="{ collapsed, open: mobileOpen }">
          <div class="side-logo"><div class="brand-mark">土</div><div v-if="!collapsed" class="brand-text"><strong>大土工作台</strong><small>运维负责人</small></div></div>
          <nav>
            <router-link v-for="item in menu" :key="item.path" :to="item.path" class="nav-item">
              <svg viewBox="0 0 24 24" class="nav-icon"><path :d="item.icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span v-if="!collapsed">{{ item.label }}</span>
            </router-link>
          </nav>
          <div class="side-footer"><button class="nav-item logout" @click="logout"><svg viewBox="0 0 24 24" class="nav-icon"><path d="M15 12H4m4-4l-4 4 4 4m4-11h6v14h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span v-if="!collapsed">退出登录</span></button></div>
        </aside>
        <button class="collapse-toggle" :class="{ collapsed }" @click="toggleSidebar" aria-label="切换菜单"><svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <main class="main">
          <header class="topbar">
            <button class="icon-btn mobile-only" @click="mobileOpen = !mobileOpen">☰</button>
            <div><h1>{{ routeTitle }}</h1><p class="muted">{{ workspace.today }} · 自动保存已开启</p></div>
            <div class="top-status"><span v-if="saving">保存中…</span><span v-else-if="toast" class="saved">已保存</span></div>
          </header>
          <router-view :workspace="workspace"></router-view>
          <div v-if="error" class="error-bar">{{ error }}</div>
        </main>
      </div>
    `
  };

  Vue.createApp(App).use(router).mount("#app");
})();
