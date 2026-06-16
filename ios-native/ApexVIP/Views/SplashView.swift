import SwiftUI

struct SplashView: View {
    @State private var revealed = false

    var body: some View {
        ZStack {
            Brand.bgDeep.ignoresSafeArea()
            VStack(spacing: 10) {
                Text("ApexVIP")
                    .font(Brand.serif(52, weight: .light))
                    .foregroundStyle(Brand.gold)
                    .tracking(2)
                    .opacity(revealed ? 1 : 0)
                    .offset(y: revealed ? 0 : 12)
                Text("LUXURY CHAUFFEUR")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(4)
                    .foregroundStyle(Brand.fg4)
                    .opacity(revealed ? 1 : 0)
            }
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.9)) { revealed = true }
        }
    }
}

#Preview { SplashView() }
