# 上游来源和许可证

职小搭网申助手 0.9.13 的浏览器引擎基于 [Nanobrowser](https://github.com/nanobrowser/nanobrowser) 提交 `24a14b76e14a9c30fd84878ca7985049d1e7d064`，沿用浏览器观察、操作、Agent 执行和页面高亮能力。Nanobrowser 采用 Apache License 2.0，原始许可证和版权声明随本仓库及构建产物分发。

0.9.13 包含招聘日历适配（`calendarAdapters.ts`）、独立整表核查（`independentFormAudit.ts`）与特殊控件探索（`unknownControlExploration.ts`），并采用页内悬浮操作与逐项核对，读取本地导入简历并直连用户配置的模型 API。

## 招聘表单组件适配参考

Phoenix、飞书 Formily、Moka、Ant Design 和 Element 的组件结构参考了 [OfferGo](https://github.com/Suara17/OfferGo-resume-filler-extension/tree/aa047cc8db351a95110739c94e2be7fe8060aa68) 的 `01_profiles.js`、`05_ats_adapters.js`、`06_solvers.js` 与 `09_agent_engine.js`。该版本采用 [MIT 许可证](https://github.com/Suara17/OfferGo-resume-filler-extension/blob/aa047cc8db351a95110739c94e2be7fe8060aa68/LICENSE)。招聘组件适配在 `recruitingAdapters.ts` 中按本项目的页面观察、字段写入与回读流程实现。模型依据简历和实际页面选项决定填写内容，最终提交由用户完成。
