import { createApp } from 'vue'
import {
  ElButton,
  ElInput,
  ElSelect,
  ElOption,
  ElDialog,
  ElSwitch,
  ElForm,
  ElFormItem,
  ElInputNumber,
  ElRadio,
  ElRadioGroup,
  ElCheckbox,
  ElCheckboxGroup,
  ElPagination,
} from 'element-plus'
import 'element-plus/dist/index.css'
import './style.css'
import App from './App.vue'
import { router } from './router'

const app = createApp(App)
for (const component of [
  ElButton,
  ElInput,
  ElSelect,
  ElOption,
  ElDialog,
  ElSwitch,
  ElForm,
  ElFormItem,
  ElInputNumber,
  ElRadio,
  ElRadioGroup,
  ElCheckbox,
  ElCheckboxGroup,
  ElPagination,
])
  app.component(component.name!, component)
app.use(router).mount('#app')
