import DashboardHeader from "@/components/DashboardHeader";
import Sidebar from "@/components/Sidebar";
import TopCards from "@/components/TopCards";
import ConversationsQueue from "@/components/ConversationsQueue";

export function DashboardIndex() {
  return (
    <div className="min-h-screen bg-background font-sans">
      <DashboardHeader />
      <div className="flex min-w-screen">
        {/* Sidebar fixo à esquerda */}
        <Sidebar />

        {/* Conteúdo principal */}
        <main className="flex flex-col lg:grow px-4 py-8">
          <TopCards />

          <ConversationsQueue />
        </main>
      </div>
    </div>
  );
}