-- AlterTable
ALTER TABLE "RoutingOperation" ADD COLUMN     "minProficiency" TEXT,
ADD COLUMN     "requiredSkillId" TEXT;

-- AddForeignKey
ALTER TABLE "RoutingOperation" ADD CONSTRAINT "RoutingOperation_requiredSkillId_fkey" FOREIGN KEY ("requiredSkillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
