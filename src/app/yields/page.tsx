import { YieldsScreen } from '@/components/screens/SimpleScreens';
import { pageCtx } from '@/lib/page';

export default async function Page() {
  await pageCtx();
  return <YieldsScreen />;
}
