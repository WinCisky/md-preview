<script lang="ts">
    import SidebarFolder from "$lib/components/sidebar-folder.svelte";
    import SidebarFile from "$lib/components/sidebar-file.svelte";

    import * as Sidebar from "$lib/components/ui/sidebar/index.js";
    import Plus from "@lucide/svelte/icons/plus";

    let items = [
        {
            type: "folder",
            name: "src",
            expanded: true,
            childrens: [
                {
                    type: "folder",
                    name: "routes",
                    expanded: true,
                    childrens: [
                        {
                            type: "file",
                            name: "+layout.svelte"
                        },
                        {
                            type: "file",
                            name: "+page.svelte"
                        }
                    ]
                },
                {
                    type: "file",
                    name: "app.css"
                },
                {
                    type: "file",
                    name: "hooks.server.ts"
                }
            ]
        }
    ];
</script>

<Sidebar.Root>
    <Sidebar.Content>
        <Sidebar.Group>
            <Sidebar.GroupLabel>
                Documents
            </Sidebar.GroupLabel>
            <Sidebar.GroupAction title="Add File">
                <Plus /> <span class="sr-only">Add File</span>
            </Sidebar.GroupAction>
            <Sidebar.GroupContent class="px-2">

                {#each items as item}
                    {#if item.type === 'folder'}
                        <SidebarFolder {...item} />
                    {:else}
                        <SidebarFile {...item} />
                    {/if}
                {/each}
            </Sidebar.GroupContent>
        </Sidebar.Group>
    </Sidebar.Content>
</Sidebar.Root>
