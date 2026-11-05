# Nanobrowser 来源

此目录基于 [nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser)
提交 `24a14b76e14a9c30fd84878ca7985049d1e7d064` 修改，沿用其浏览器
观察、操作、逐步 Agent 执行和页面高亮能力。原项目采用 Apache License 2.0，
原始许可证见本目录 `LICENSE`。本网申助手的适配集中在 `chrome-extension/`、
本地简历导入、用户自配模型和求职侧栏，保留上游版权声明。


## 招聘表单组件适配参考

参考 [OfferGo](https://github.com/Suara17/OfferGo-resume-filler-extension/tree/aa047cc8db351a95110739c94e2be7fe8060aa68)
的 `01_profiles.js`、`05_ats_adapters.js`、`06_solvers.js` 与 `09_agent_engine.js`
梳理 Phoenix、飞书 Formily、Moka 及 AntD / Element 的组件结构与校验等待方式。
参考版本采用 [MIT 许可证](https://github.com/Suara17/OfferGo-resume-filler-extension/blob/aa047cc8db351a95110739c94e2be7fe8060aa68/LICENSE)。

这里按现有 Page / FormWrite / Review 调用链重新实现，结构规则集中于
`chrome-extension/src/background/browser/recruitingAdapters.ts`。
适配只负责 DOM 控件、选项归属和校验，答案仍由 Agent 根据资料及真实选项决定。
没有引入参考项目的 React 私有状态调用、语义关键词映射、日期默认值或自动提交。

当前验证覆盖合成组件页面：组件根与搜索框的区分、真实选中值、精确选项、
相邻浮层隔离、字段错误归属和延迟校验；这不等于已经验证各招聘平台所有线上版本。
日期面板继续复用现有通用实现，未声明新增平台级联地址或特殊日期范围兼容。
