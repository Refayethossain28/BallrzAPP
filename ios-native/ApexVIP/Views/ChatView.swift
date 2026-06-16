import SwiftUI

struct ChatView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    private let quickReplies = ["👋 On my way down", "Running 5 min late", "Which entrance?", "Thank you!"]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                messages
                quickReplyBar
                inputBar
            }
            .background(Brand.bg.ignoresSafeArea())
            .navigationTitle(store.activeTrip?.driver ?? "Chauffeur")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }.tint(Brand.gold)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Link(destination: URL(string: "tel:+447700000000")!) {
                        Image(systemName: "phone.fill").foregroundStyle(Brand.gold)
                    }
                }
            }
            .toolbarBackground(Brand.bgDeep, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    if store.chat.isEmpty {
                        Text("Start a conversation")
                            .font(.system(size: 14)).foregroundStyle(Brand.fg4)
                            .padding(.top, 60)
                    }
                    ForEach(store.chat) { bubble($0) }
                }
                .padding(16)
            }
            .onChange(of: store.chat.count) { _ in
                if let last = store.chat.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    private func bubble(_ m: ChatMessage) -> some View {
        let isMe = m.fromRole == .client
        return HStack {
            if isMe { Spacer(minLength: 50) }
            Text(m.message)
                .font(.system(size: 14))
                .foregroundStyle(isMe ? Color.black : Brand.fg)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(isMe
                    ? AnyShapeStyle(LinearGradient(colors: [Brand.gold, Brand.goldDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
                    : AnyShapeStyle(Brand.surface2))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            if !isMe { Spacer(minLength: 50) }
        }
        .id(m.id)
    }

    private var quickReplyBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(quickReplies, id: \.self) { q in
                    Button { store.send(q) } label: {
                        Text(q).font(.system(size: 12)).foregroundStyle(Brand.fg2)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(Brand.surface)
                            .overlay(Capsule().stroke(Brand.border, lineWidth: 1))
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("", text: $draft, prompt: Text("Message your chauffeur…").foregroundColor(Brand.fg4))
                .foregroundStyle(Brand.fg)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(Brand.surface)
                .overlay(Capsule().stroke(Brand.border, lineWidth: 1))
                .clipShape(Capsule())
            Button {
                store.send(draft); draft = ""
            } label: {
                Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Brand.bgDeep)
                    .frame(width: 44, height: 44).background(Brand.gold).clipShape(Circle())
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Brand.bgDeep)
    }
}

#Preview {
    let s = AppStore(); s.signIn(email: ""); s.openChat(for: DemoData.trips[0])
    return ChatView().environmentObject(s)
}
