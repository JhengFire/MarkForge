# MDView 功能自测文档

[TOC]

## 1. 基础 Markdown

**粗体**、*斜体*、~~删除线~~、`行内代码`、[外链](https://www.example.com)、H~2~O、x^2^、==高亮==、++下划线++

> 引用块第一行
> 引用块第二行

- 无序项 A
- 无序项 B
  - 嵌套项 B-1
  - 嵌套项 B-2

1. 有序项一
2. 有序项二

- [x] 已完成任务
- [ ] 未完成任务

### 表格

| 左对齐 | 居中 | 右对齐 |
| :--- | :---: | ---: |
| 内容 A | 内容 B | 1234 |
| `code` | **粗** | 5.67 |

### 脚注

这里引用一个脚注[^note]，还有一个[^second]。

[^note]: 第一个脚注的内容。
[^second]: 第二个脚注，包含 `代码`。

### 代码块

```javascript
const greet = (name) => `你好，${name}！`;
console.log(greet('MDView'));
```

```python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b
```

## 2. 数学公式

行内：当 $a \ne 0$ 时，$ax^2+bx+c=0$ 的根为 $x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$。

块级：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

矩阵与分段函数：

$$
A = \begin{pmatrix} a_{11} & a_{12} \\ a_{21} & a_{22} \end{pmatrix},
\qquad
f(x) = \begin{cases}
x^2, & x \ge 0 \\
-x,  & x < 0
\end{cases}
$$

多行对齐：

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \times \mathbf{B} &= \mu_0 \mathbf{J}
\end{aligned}
$$

公式里的中文：$\text{面积} = \pi r^2$

反引号内不解析公式：`$x^2$` 应当原样显示。

行内代码与公式混排：先 `npm run build`，再用 $\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$ 计算。

## 3. Mermaid 图表

```mermaid
flowchart TD
    A[开始] --> B{是否已登录?}
    B -- 是 --> C[进入主页]
    B -- 否 --> D[跳转登录页]
    D --> E[校验账号密码]
    E -->|成功| C
    E -->|失败| F[提示错误]
    F --> D
    C --> G((结束))
```

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant W as 前端
    participant S as 服务端
    U->>W: 点击导出
    W->>S: POST /export
    S-->>W: 返回下载地址
    W-->>U: 触发下载
```

```mermaid
stateDiagram-v2
    [*] --> 草稿
    草稿 --> 已提交: 提交
    已提交 --> 已发布: 审核通过
    已提交 --> 草稿: 驳回
    已发布 --> [*]
```

```mermaid
pie title 导出格式占比
    "Word" : 45
    "PDF" : 35
    "HTML" : 20
```

### 3.1 思维导图（语言标记直接写 mindmap）

```mindmap
mindmap
    root((MDView 能力))
        编辑
            CodeMirror 6
            快捷键与工具栏
            大纲与滚动同步
        渲染
            Mermaid
            PlantUML
            KaTeX 公式
        导出
            Word
                docx
                公式转图片
            PDF
            HTML
        工程
            Electron
            esbuild 打包
            electron-builder
```

## 4. PlantUML 图表

```plantuml
@startuml
skinparam backgroundColor #FFFFFF
skinparam shadowing false
actor 用户 as U
participant "MDView" as M
database "本地文件" as F
U -> M : 打开 .md
M -> F : 读取
F --> M : 内容
M --> U : 渲染预览
U -> M : 导出 Word
M -> F : 写入 .docx
@enduml
```

## 5. 分页与收尾

\pagebreak

这一节位于新的一页（打印 / 导出 PDF 时生效）。

---

*文档结束。*
