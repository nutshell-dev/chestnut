import AppKit
import SwiftUI

/// 流式贴底锚（phase 2007 Step C）。
///
/// 事实背景（phase2007-logs/step-a-visual-scroll-facts.md）：
/// `ScrollViewProxy.scrollTo` 在流式文本更新事务中会被 SwiftUI 丢弃——2003 内容栈
/// LazyVStack→VStack（修测量闭环）后该路径基本失效，main 实机探针贴底 2/89；
/// expanded 阶段窗口增长掩盖问题，capped 后暴露；turn_end footer 撤销造成的
/// 内容露出不等于滚动。本类型是 post-layout 贴底机制的独立 owner。
///
/// 机制：0 布局成本的 AnchorView 放在回复区内容背景里。contentRevision
/// （只由消息数/末条文本变化产生——打字等无关重渲染被 revision 门控挡住）
/// 变化 → requestPostLayoutScrollToBottom：AppKit layout pass 中文档高度已最终化，
/// 此时贴底无滞后；无 display link 环境由 10ms 重试链兜底（有上限、可被新
/// revision 取消、已贴底即停）。只读布局后的 document frame，不写任何
/// SwiftUI 状态——无测量反馈环。
/// 跟随语义维持现状：始终贴底；用户上滚暂停跟随是另一项设计决策，不在本 phase。
struct ScrollFollowAnchor: NSViewRepresentable {
    /// 内容版本号：消息数与末条文本长度派生（流式快照/新消息/组结构变化都覆盖）。
    let contentRevision: Int

    final class AnchorView: NSView {
        static let maxNudgeAttempts = 10
        static let nudgeInterval: TimeInterval = 0.01

        /// 待消费的 revision（layout pass 消费）；重复 revision 被门控。
        private(set) var pendingRevision: Int?
        /// 请求计数（去重可观测，测试用）。
        private(set) var requestCount = 0
        private var lastRequestedRevision: Int?
        private var lastLayoutRevision: Int?
        private var nudgeGeneration = 0

        /// 新内容 revision 请求贴底：重复 revision 去重；新一轮取消上一轮重试链。
        func requestPostLayoutScrollToBottom(revision: Int) {
            guard revision != lastRequestedRevision else { return }
            lastRequestedRevision = revision
            requestCount += 1
            pendingRevision = revision
            needsLayout = true
            nudgeGeneration += 1
            nudgeUntilPinned(generation: nudgeGeneration)
        }

        override func layout() {
            super.layout()
            // layout pass 是文档高度最终化的唯一可靠时点；滚动成功才消费 revision，
            // 失败（如文档尚未撑开）留给后续 layout pass 或重试链
            guard let revision = pendingRevision, revision != lastLayoutRevision else { return }
            if scrollToBottom() { lastLayoutRevision = revision }
        }

        /// 布局完成后贴底：读最终 document frame 与 viewport，直滚 AppKit 层。
        @discardableResult
        func scrollToBottom() -> Bool {
            guard let scrollView = enclosingScrollView,
                  let document = scrollView.documentView else { return false }
            let y = document.frame.height - scrollView.contentView.bounds.height
            guard y > 0 else { return false }
            scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
            scrollView.reflectScrolledClipView(scrollView.contentView)
            return true
        }

        func isPinnedToBottom() -> Bool {
            guard let scrollView = enclosingScrollView,
                  let document = scrollView.documentView else { return true }
            return abs(scrollView.documentVisibleRect.maxY - document.frame.height) < 1
        }

        /// 无 display link 环境的贴底重试链：已贴底即停；新 revision 作废旧链；
        /// 上限 maxNudgeAttempts 防环。
        private func nudgeUntilPinned(generation: Int, attempt: Int = 0) {
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.nudgeInterval) { [weak self] in
                guard let self, generation == self.nudgeGeneration else { return }
                guard !self.isPinnedToBottom() else { return }
                self.scrollToBottom()
                if attempt < Self.maxNudgeAttempts {
                    self.nudgeUntilPinned(generation: generation, attempt: attempt + 1)
                }
            }
        }
    }

    /// 视图身份重建时的 revision 去重（稳定背景节点之外的第二道门）。
    final class Coordinator {
        var lastRevision: Int?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView { AnchorView() }

    func updateNSView(_ nsView: NSView, context: Context) {
        guard context.coordinator.lastRevision != contentRevision else { return }
        context.coordinator.lastRevision = contentRevision
        guard let anchor = nsView as? AnchorView else { return }
        anchor.requestPostLayoutScrollToBottom(revision: contentRevision)
    }
}
