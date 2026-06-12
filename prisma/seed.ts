import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.feePlan.upsert({
    where: { name: 'standard' },
    update: {},
    create: {
      name: 'standard',
      percentBps: 200,      // 2%
      fixedPaise: 300,      // ₹3 flat
      intlPercentBps: 350,  // 3.5% international
      currency: 'INR',
    },
  });

  console.log('Seed complete');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());