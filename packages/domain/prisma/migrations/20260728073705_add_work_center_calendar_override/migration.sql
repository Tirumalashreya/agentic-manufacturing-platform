-- AlterTable
ALTER TABLE "WorkCenter" ADD COLUMN     "holidayCalendarId" TEXT,
ADD COLUMN     "workingDaysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AddForeignKey
ALTER TABLE "WorkCenter" ADD CONSTRAINT "WorkCenter_holidayCalendarId_fkey" FOREIGN KEY ("holidayCalendarId") REFERENCES "HolidayCalendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;
