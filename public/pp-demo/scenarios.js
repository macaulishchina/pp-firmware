/** Add a declaration here to add a scene. The sidebar, model and paging follow automatically. */
export const scenarios = [
  {
    id: 'short', title: '轻松聊一句', description: '短回答，直接听完', symbol: '↗',
    prompt: '今天适合出去散步吗？',
    reply: '当然可以。选一条安静的小路，放下手机，慢慢走一会儿。天气和路线还需要你自己确认，我在这里陪你。',
  },
  {
    id: 'long', title: '一段长回答', description: '简短播报，全文翻页', symbol: '≋',
    prompt: '给我一些周末放松的建议。',
    reply: '这个周末，给自己留一点没有安排的时间。\n\n上午找一家喜欢的小店吃早餐，再去附近的公园走走。带一本书，坐下来读几页，不必赶进度。\n\n下午可以整理一小块生活空间，听一张完整的专辑，或者给很久没联系的人打个电话。\n\n晚上做一顿简单的饭，选一部想看的电影。少一点必须完成的事情，多一点能让自己舒服的选择。\n\n如果你愿意，下次告诉我你更想待在家，还是出去走走，我可以帮你把安排再缩小一点。',
    longPlayback: true,
  },
  {
    id: 'task', title: '交给后台做', description: '任务继续，结果稍后到', symbol: '⌁',
    prompt: '后台帮我整理一份周末电影推荐。',
    reply: '已经交给后台整理了。你可以继续聊天，结果回来后，会留在这台 PP 的任务消息里。',
    background: {
      title: '电影推荐已整理好',
      body: '你的周末片单已经整理好。\n\n推荐先看《海街日记》，适合想慢下来的晚上；如果想轻松一些，可以选《布达佩斯大饭店》。\n\n这是模拟任务报告，没有搜索或转存真实资源。',
    },
  },
  {
    id: 'clarify', title: '需要问清楚', description: '再说一句，补全信息', symbol: '?',
    prompt: '帮我设置一个提醒。',
    reply: '你想几点提醒？再按住 OK，告诉我时间就好。',
    clarification: {
      prompt: '晚上八点，提醒我休息。',
      reply: '好的，已记下晚上八点提醒你休息。（交互演示，没有创建真实提醒。）',
    },
  },
];
