// *.vue 环境声明 —— @cordisjs/client 的 types 直指 TS 源码（exports '.' →
// './client/index.ts'），tsc 顺着类型链会走进它的 *.vue 单文件组件；
// 没有这条声明就报 TS2307（Cannot find module './k-button.vue'）。
// 本仓库仍然零 .vue 文件（铁律 1），这里只是让类型链走得通。
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
