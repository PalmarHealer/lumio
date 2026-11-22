import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { getShowApi } from '@jellyfin/sdk/lib/utils/api/show-api'
import { getUserViewApi } from '@jellyfin/sdk/lib/utils/api/user-view-api'
import { useQuery } from '@tanstack/react-query'
import { useAuthedSession } from '@/features/auth/session'
import { unfinished } from '@/features/items/queries'

const fields = [ItemFields.PrimaryImageAspectRatio, ItemFields.Overview]

export function useResumeItems() {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['resume', session.userId],
    // Asked for a few more: watched episodes opened again are left out (see unfinished).
    queryFn: async () =>
      unfinished((await getLibraryApi(api).getResumeItems({ userId: session.userId, limit: 24, mediaTypes: ['Video'], fields })).data.Items).slice(0, 16),
  })
}

export function useNextUp() {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['next-up', session.userId],
    queryFn: async () => (await getShowApi(api).getNextUp({ userId: session.userId, limit: 16, fields })).data.Items ?? [],
  })
}

export function useUserViews() {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['views', session.userId],
    queryFn: async () => (await getUserViewApi(api).getUserViews({ userId: session.userId })).data.Items ?? [],
  })
}
